/** Retains cancellation selection, session facts, and exact dispatch ownership. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { isSessionDeliveryGenerationRevokedError } from "../../../config/sessions/session-delivery-generation.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { holdQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import {
  ensureSubagentControllerOwnsRun,
  getLatestOwnedSubagentRun,
  isCurrentSubagentRun,
  type ResolvedSubagentController,
} from "./subagent-control-scope.js";
import {
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import type { SubagentCancellationControl } from "./subagent-control.types.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import {
  captureSubagentExecution,
  getSubagentExecutionCleanup,
} from "./subagent-registry-execution-cleanup.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import { listRunsForControllerFromRuns } from "./subagent-registry-queries.js";
import { withSubagentRunReadSnapshot } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration, isSameSubagentRunOwner } from "./subagent-run-generation.js";

type KillBinding = {
  entry: SubagentRunRecord;
  isCurrent: (entry: SubagentRunRecord, requirePreparedSession?: boolean) => boolean;
  ownsRun: () => boolean;
  canTraverse: (requirePreparedSession?: boolean) => boolean;
  prepareRead: SubagentKillSession["prepareRead"];
};

export type KillTree = KillBinding & {
  session?: SubagentKillSession;
  children: KillTree[];
  errors: Set<string>;
  completedCleanupError?: string;
  discoveryFailed: boolean;
  dispatchHold?: ReturnType<typeof holdQueuedSwarmRun>;
};

export type KillSelection = {
  cfg: OpenClawConfig;
  runs: Iterable<SubagentRunRecord>;
  assertCurrent?: () => void;
  prepareRead?: () => Promise<void> | undefined;
  ownsRoot?: (entry: SubagentRunRecord) => boolean;
  controller?: Pick<ResolvedSubagentController, "controllerSessionKey" | "controllerAgentId">;
};

export type KillScope = {
  cancellationControl: SubagentCancellationControl;
  refresh: () => Promise<number>;
  stateContext: OpenClawStateWorkerContext;
};

export type KillPublicationPreparation<T> = {
  prepare: (
    publish: (prepareRows?: (publishResult: () => void) => Promise<void>) => Promise<void>,
  ) => Promise<void>;
  publishSnapshot?: (result: T) => void;
};

export async function withSubagentKillScope<T>(
  params: KillSelection,
  run: (scope: KillScope, trees: KillTree[]) => Promise<T>,
  captureResult?: (result: T, trees: KillTree[]) => T,
  preparePublication?: KillPublicationPreparation<T>,
  finishResult?: (result: T) => T,
): Promise<T> {
  // Discovery retains the cancellation scope, not a child's temporary write admission.
  const runInScope = AsyncLocalStorage.snapshot();
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const stateContext = captureOpenClawStateWorkerContext();
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    params.assertCurrent?.();
  };
  const cancellationControl = {
    prepareRead: params.prepareRead,
    assertCurrent,
  };
  const selected = new Map<string, Set<string | undefined>>();
  let selectedCount = 0;
  const releaseSessions: Array<SubagentKillSession["release"]> = [];
  const releaseRetirements: Array<() => void> = [];
  const completeRetirementPublications: Array<() => void> = [];
  const holds: Array<NonNullable<ReturnType<typeof holdQueuedSwarmRun>>> = [];
  const hold = (tree: KillTree) => {
    if (!tree.dispatchHold) {
      tree.dispatchHold = holdQueuedSwarmRun(tree.entry.schedulerSlotId ?? tree.entry.runId);
      if (tree.dispatchHold) {
        holds.push(tree.dispatchHold);
      }
    }
  };
  const capture = (
    pending: Array<{ tree: KillTree; prepare: () => Promise<void> }>,
    runs: Iterable<SubagentRunRecord>,
    trees: KillTree[],
    owner?: KillSelection["controller"],
    parent?: KillBinding,
    ownsRoot?: (entry: SubagentRunRecord) => boolean,
  ): void => {
    const controller = owner ? { ...owner } : undefined;
    for (const snapshot of runs) {
      assertCurrent();
      const childOwner = parseAgentSessionKey(snapshot.childSessionKey)
        ? undefined
        : (snapshot.childAgentId ?? resolveSubagentRequesterAgentId(params.cfg, snapshot));
      const entry = getLatestOwnedSubagentRun(snapshot.childSessionKey, childOwner, params.cfg);
      const selectedForChild = selected.get(snapshot.childSessionKey) ?? new Set();
      if (!entry || !isSameSubagentRunOwner(entry, snapshot) || selectedForChild.has(childOwner)) {
        continue;
      }
      const ownerCurrent = (candidate: SubagentRunRecord, requirePreparedSession = true) =>
        isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
        parent?.canTraverse(requirePreparedSession) !== false &&
        ownsRoot?.(candidate) !== false &&
        (!controller ||
          !ensureSubagentControllerOwnsRun({ cfg: params.cfg, controller, entry: candidate }));
      if (!ownerCurrent(entry, false) || !isCurrentSubagentRun(entry, params.cfg)) {
        continue;
      }
      selectedForChild.add(childOwner);
      selected.set(entry.childSessionKey, selectedForChild);
      selectedCount += 1;
      const errors = new Set<string>();
      let session: SubagentKillSession | undefined;
      const ownsSessionIncarnation = () => {
        if (!session) {
          return false;
        }
        try {
          session.assertCurrent();
          return true;
        } catch (error) {
          if (isSessionDeliveryGenerationRevokedError(error)) {
            return false;
          }
          throw error;
        }
      };
      const { childSessionKey } = entry;
      const latest = () => getLatestOwnedSubagentRun(childSessionKey, childOwner, params.cfg);
      const retirement = subagentRuns.captureRetirement(entry, (candidate) =>
        isSameSubagentRunOwner(latest(), candidate),
      );
      completeRetirementPublications.push(retirement.completePublication);
      releaseRetirements.push(retirement.release);
      const selectedEntry = () => retirement.observation.entry;
      const ownsRun = () => {
        const observed = retirement.observation;
        const current = observed.entry;
        return (
          current !== undefined &&
          isSameSubagentRunOwner(current, entry) &&
          isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
          (isSameSubagentRunOwner(getCurrentSubagentRunOwner(subagentRuns, current), current) ||
            observed.state === "retired")
        );
      };
      const isCurrent = (candidate: SubagentRunRecord, requirePreparedSession = true) => {
        const current = getCurrentSubagentRunOwner(subagentRuns, entry);
        return (
          current !== undefined &&
          isSameSubagentRunOwner(candidate, entry) &&
          isSameSubagentRunOwner(current, entry) &&
          ownsRun() &&
          ownerCurrent(current, requirePreparedSession) &&
          isCurrentSubagentRun(current, params.cfg) &&
          (!requirePreparedSession || ownsSessionIncarnation())
        );
      };
      const canTraverse = (requirePreparedSession = true) => {
        const current = selectedEntry();
        if (!current || !ownerCurrent(current, requirePreparedSession) || !ownsRun()) {
          return false;
        }
        const replacement = latest();
        return (
          (isSameSubagentRunOwner(replacement, current) ||
            (retirement.observation.state === "retired" &&
              (!replacement || compareSubagentRunGeneration(replacement, current) < 0))) &&
          (!requirePreparedSession || ownsSessionIncarnation())
        );
      };
      const prepareRead = (): Promise<void> | undefined => {
        const failures: unknown[] = [];
        const publications = [parent?.prepareRead, session?.prepareRead].flatMap((prepare) => {
          try {
            const publication = prepare?.();
            return publication ? [publication] : [];
          } catch (error) {
            // The synchronous ownership check handles a known-revoked generation.
            if (!isSessionDeliveryGenerationRevokedError(error)) {
              failures.push(error);
            }
            return [];
          }
        });
        const throwFailures = () => {
          if (failures.length === 1) {
            throw failures[0];
          }
          if (failures.length > 1) {
            throw new AggregateError(failures, "Subagent publication readiness failed");
          }
        };
        if (publications.length === 0) {
          throwFailures();
          return undefined;
        }
        return Promise.allSettled(publications).then((results) => {
          try {
            assertSubagentRegistryWriteSourceCurrent(stateContext);
          } catch (error) {
            failures.push(error);
          }
          for (const result of results) {
            if (
              result.status === "rejected" &&
              !isSessionDeliveryGenerationRevokedError(result.reason)
            ) {
              failures.push(result.reason);
            }
          }
          throwFailures();
        });
      };
      const tree: KillTree = {
        get entry() {
          return selectedEntry() ?? entry;
        },
        isCurrent,
        ownsRun,
        canTraverse,
        prepareRead,
        session,
        children: [],
        errors,
        discoveryFailed: errors.size > 0,
      };
      hold(tree);
      // Publish each captured hold before another candidate's authority read can throw.
      trees.push(tree);
      pending.push({
        tree,
        prepare: async () => {
          try {
            const selectedRun = tree.entry;
            session = await prepareSubagentKillSession(
              params.cfg,
              selectedRun.childSessionKey,
              () => assertSubagentRegistryWriteSourceCurrent(stateContext),
              selectedRun.execution.transcriptTarget,
              selectedRun.childAgentId,
            );
            releaseSessions.push(session.release);
            if (!tree.canTraverse(false)) {
              return;
            }
            tree.session = session;
          } catch (error) {
            if (hasSqliteWorkerOutcomeUnknown(error)) {
              throw error;
            }
            errors.add(formatErrorMessage(error));
            tree.discoveryFailed = true;
          }
        },
      });
    }
  };
  const select = async (
    runs: Iterable<SubagentRunRecord>,
    trees: KillTree[],
    owner?: KillSelection["controller"],
    parent?: KillBinding,
    ownsRoot?: (entry: SubagentRunRecord) => boolean,
  ) => {
    const pending: Array<{ tree: KillTree; prepare: () => Promise<void> }> = [];
    capture(pending, runs, trees, owner, parent, ownsRoot);
    // Resident reservations can dispatch on the first await. Capture all known roots and
    // descendants first; persisted-only discovery below remains worker-owned.
    const resident = new Map(subagentRuns);
    for (const { tree } of pending) {
      const controller = {
        controllerSessionKey: tree.entry.childSessionKey,
        controllerAgentId: resolveSubagentChildSessionOwner(tree.entry, params.cfg).agentId,
      };
      capture(
        pending,
        listRunsForControllerFromRuns(resident, controller.controllerSessionKey),
        tree.children,
        controller,
        tree,
      );
    }
    for (const item of pending) {
      await item.prepare();
    }
  };
  const refreshTree = async (tree: KillTree) => {
    if (tree.discoveryFailed) {
      return;
    }
    try {
      for (let pending = tree.prepareRead(); pending; pending = tree.prepareRead()) {
        await pending;
      }
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      try {
        params.assertCurrent?.();
      } catch (error) {
        if (
          !hasSqliteWorkerOutcomeUnknown(error) &&
          tree.entry.execution.status === "terminal" &&
          tree.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
          tree.entry.killReconciliation?.taskCancellationAccepted === true &&
          tree.canTraverse()
        ) {
          // A retired caller cannot discover new work. Already accepted outcomes remain
          // observable; every unfinished captured descendant still checks its caller.
          for (const child of tree.children) {
            await refreshTree(child);
          }
          return;
        }
        throw error;
      }
      if (!tree.canTraverse()) {
        return;
      }
      if (tree.isCurrent(tree.entry)) {
        hold(tree);
        const controller = {
          controllerSessionKey: tree.entry.childSessionKey,
          controllerAgentId: resolveSubagentChildSessionOwner(tree.entry, params.cfg).agentId,
        };
        // Retirement preserves captured work, not discovery beneath a missing ancestor.
        const candidates = await withSubagentRunReadSnapshot(
          subagentRuns,
          (snapshot) => ({
            runIds: [...snapshot.values()]
              .filter(
                (candidate) =>
                  (candidate.controllerSessionKey?.trim() || candidate.requesterSessionKey) ===
                  controller.controllerSessionKey,
              )
              .map((candidate) => candidate.runId),
            sessionKeys: [controller.controllerSessionKey],
          }),
          (_selection, runs) =>
            listRunsForControllerFromRuns(new Map(runs), controller.controllerSessionKey),
          { sessionKeys: [controller.controllerSessionKey], descendants: false },
        );
        assertCurrent();
        for (let pending = tree.prepareRead(); pending; pending = tree.prepareRead()) {
          await pending;
          assertCurrent();
        }
        await select(candidates, tree.children, controller, tree);
      }
      for (const child of tree.children) {
        await refreshTree(child);
      }
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      tree.discoveryFailed = true;
      tree.errors.add(formatErrorMessage(error));
    }
  };
  const trees: KillTree[] = [];
  let queuedRefresh: ReturnType<typeof createDeferredCore<number>> | undefined;
  let refreshWork: Promise<void> | undefined;
  let refreshing = false;
  let refreshClosed = false;
  let refreshFailure: { error: unknown; promise: Promise<number> } | undefined;
  const refresh = (): Promise<number> => {
    if (refreshClosed) {
      return Promise.reject(new Error("Subagent cancellation refresh scope is no longer active"));
    }
    if (refreshFailure) {
      return refreshFailure.promise;
    }
    const batch = (queuedRefresh ??= createDeferredCore<number>());
    void batch.promise.catch(() => {});
    if (!refreshing) {
      refreshing = true;
      refreshWork = runInScope(async () => {
        try {
          while (queuedRefresh) {
            const current = queuedRefresh;
            queuedRefresh = undefined;
            try {
              for (const tree of trees) {
                await refreshTree(tree);
              }
              current.resolve(selectedCount);
            } catch (error) {
              refreshFailure = { error, promise: current.promise };
              current.reject(error);
              throw error;
            }
          }
        } finally {
          refreshing = false;
        }
      }).catch((error: unknown) => {
        queuedRefresh?.reject(error);
        queuedRefresh = undefined;
      });
    }
    return batch.promise;
  };
  const withPublication = async (publish: () => void) => {
    let publicationActive = true;
    let publicationConsumed = false;
    const publishResult = () => {
      if (!publicationActive) {
        throw new Error("Subagent cancellation publication scope is no longer active");
      }
      if (publicationConsumed) {
        throw new Error("Subagent cancellation result was already published");
      }
      publicationConsumed = true;
      publish();
    };
    const publicationSession = captureResult ? trees[0]?.session : undefined;
    const publishPrepared = async (prepareRows?: (publishResult: () => void) => Promise<void>) => {
      const prepareResult = async () => {
        if (prepareRows) {
          await prepareRows(publishResult);
        } else {
          publishResult();
        }
      };
      if (publicationSession) {
        await publicationSession.withPublication(prepareResult);
      } else {
        await prepareResult();
      }
    };
    try {
      if (preparePublication) {
        await preparePublication.prepare(publishPrepared);
      } else {
        await publishPrepared();
      }
      if (!publicationConsumed) {
        throw new Error("Subagent cancellation publication did not consume its prepared scope");
      }
    } finally {
      publicationActive = false;
    }
  };
  let outcome: { ok: true; rawResult: T; value: T } | { ok: false; error: unknown };
  try {
    assertCurrent();
    await select(params.runs, trees, params.controller, undefined, params.ownsRoot);
    const scope: KillScope = {
      cancellationControl,
      stateContext,
      refresh,
    };
    await scope.refresh();
    const result = await run(scope, trees);
    refreshClosed = true;
    await refreshWork;
    if (refreshFailure) {
      throw refreshFailure.error;
    }
    let snapshot: T = result;
    await withPublication(() => {
      if (captureResult) {
        assertCurrent();
      }
      snapshot = captureResult ? captureResult(result, trees) : result;
      if (preparePublication?.publishSnapshot?.(snapshot) !== undefined) {
        throw new TypeError("Subagent cancellation snapshot publication must be synchronous.");
      }
    });
    outcome = { ok: true, rawResult: result, value: snapshot };
  } catch (error) {
    outcome = { ok: false, error };
  }
  refreshClosed = true;
  await refreshWork;
  if (refreshFailure && !outcome.ok && outcome.error !== refreshFailure.error) {
    outcome = {
      ok: false,
      error: new AggregateError(
        [outcome.error, refreshFailure.error],
        "Subagent cancellation and discovery failed",
      ),
    };
  }
  // Failed-launch cleanup may own the same provisional session. Let it proceed only
  // after the selected snapshot publishes (including failure), before releasing a
  // scheduler hold that can itself await that cleanup.
  completeRetirementPublications.forEach((complete) => complete());
  const settleQueued = async (tree: KillTree): Promise<void> => {
    const { entry, session, dispatchHold } = tree;
    const executionTail =
      session &&
      (captureSubagentExecution({ entry, session })?.execution.executionSettlement ??
        getSubagentExecutionCleanup(entry, session.entry)?.settlement);
    if (executionTail && !executionTail.cleanupSettled) {
      return;
    }
    if (
      tree.errors.size !== 0 ||
      !dispatchHold ||
      !session?.entry?.sessionId ||
      entry.collect !== true ||
      entry.execution.status !== "terminal" ||
      entry.execution.startedAt !== undefined ||
      entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
      !entry.killReconciliation ||
      !(await dispatchHold.settleCancellation())
    ) {
      return;
    }
    for (let pending = tree.prepareRead(); pending; pending = tree.prepareRead()) {
      await pending;
    }
    const { execution, killReconciliation } = tree.entry;
    const isCurrent = () => {
      const current = tree.entry;
      return (
        tree.isCurrent(entry) &&
        isDeepStrictEqual(current.execution, execution) &&
        isDeepStrictEqual(current.killReconciliation, killReconciliation)
      );
    };
    if (outcome.ok && isCurrent()) {
      const assertQueuedPublicationCurrent = () => {
        cancellationControl.assertCurrent();
        if (!isCurrent()) {
          throw new Error("Queued cancellation no longer owns its terminal publication");
        }
      };
      assertQueuedPublicationCurrent();
      await persistSubagentSessionTiming(tree.entry, {
        session,
        isCurrentGeneration: isCurrent,
        assertCommitAllowed: assertQueuedPublicationCurrent,
        settledQueuedCancellation: {
          storePath: session.storePath,
          sessionId: session.entry.sessionId,
          lifecycleRevision: session.entry.lifecycleRevision,
        },
      });
      assertQueuedPublicationCurrent();
    }
  };
  const selectedSettlements = (selectedTrees: KillTree[]): Array<Promise<void>> =>
    selectedTrees.flatMap((tree) => [settleQueued(tree), ...selectedSettlements(tree.children)]);
  const settlements = await Promise.allSettled(selectedSettlements(trees));
  const settlementErrors = settlements.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (settlementErrors.length > 0) {
    const errors = outcome.ok ? settlementErrors : [outcome.error, ...settlementErrors];
    outcome = {
      ok: false,
      error:
        errors.length === 1
          ? errors[0]
          : new AggregateError(errors, "Subagent cancellation publication and cleanup failed"),
    };
  }
  if (outcome.ok) {
    try {
      const rawResult = outcome.rawResult;
      let published = outcome.value;
      await withPublication(() => {
        if (captureResult) {
          assertCurrent();
        }
        const result = captureResult ? captureResult(rawResult, trees) : rawResult;
        published = finishResult ? finishResult(result) : result;
      });
      outcome = { ok: true, rawResult, value: published };
    } catch (error) {
      outcome = { ok: false, error };
    }
  }
  const released = await Promise.allSettled(holds.map((reservation) => reservation.release()));
  const retired = await Promise.allSettled(releaseRetirements.map(async (release) => release()));
  const releasedSessions = await Promise.allSettled(
    releaseSessions.map(async (release) => release()),
  );
  if (!outcome.ok) {
    throw outcome.error;
  }
  for (const result of [...released, ...retired, ...releasedSessions]) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  return outcome.value;
}
