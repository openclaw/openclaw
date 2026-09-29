import { isSessionDeliveryGenerationRevokedError } from "../../../config/sessions/session-delivery-generation.js";
/** Retains cancellation selection, session facts, and exact dispatch ownership. */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import { holdQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  ensureSubagentControllerOwnsRun,
  getLatestOwnedSubagentRun,
  isCurrentSubagentRun,
  isSameSubagentRunGeneration,
  type ResolvedSubagentController,
} from "./subagent-control-scope.js";
import {
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import type { SubagentCancellationControl } from "./subagent-control.types.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import { listRunsForControllerFromRuns } from "./subagent-registry-queries.js";
import { withSubagentRunReadSnapshot } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

type KillBinding = {
  entry: SubagentRunRecord;
  isCurrent: (entry: SubagentRunRecord, requirePreparedSession?: boolean) => boolean;
  ownsRun: () => boolean;
  canTraverse: (requirePreparedSession?: boolean) => boolean;
};

export type KillTree = KillBinding & {
  session?: SubagentKillSession;
  children: KillTree[];
  errors: Set<string>;
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
  cancellationControl: SubagentCancellationControl | undefined;
  refresh: () => Promise<number>;
  stateContext: OpenClawStateWorkerContext;
};

export type KillPublicationPreparation = {
  prepare: () => Promise<void>;
  needsPreparation: () => boolean;
};

export async function withSubagentKillScope<T>(
  params: KillSelection,
  run: (scope: KillScope, trees: KillTree[]) => Promise<T>,
  publish?: (result: T, trees: KillTree[]) => T,
  preparePublication?: KillPublicationPreparation,
): Promise<T> {
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const stateContext = captureOpenClawStateWorkerContext();
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    params.assertCurrent?.();
  };
  const cancellationControl = {
    prepareRead: params.prepareRead,
    assertCurrent: () => {
      assertCurrent();
    },
  };
  const selected = new Set<string>();
  const releaseSessions: Array<() => void> = [];
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
    isParentCurrent?: (requirePreparedSession?: boolean) => boolean,
    ownsRoot?: (entry: SubagentRunRecord) => boolean,
  ): void => {
    const controller = owner ? { ...owner } : undefined;
    for (const snapshot of runs) {
      assertCurrent();
      const entry = getLatestOwnedSubagentRun(
        snapshot.childSessionKey,
        snapshot.requesterAgentId,
        params.cfg,
      );
      if (
        !entry ||
        !isSameSubagentRunGeneration(entry, snapshot) ||
        selected.has(entry.childSessionKey)
      ) {
        continue;
      }
      const ownerCurrent = (candidate: SubagentRunRecord, requirePreparedSession = true) =>
        isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
        isParentCurrent?.(requirePreparedSession) !== false &&
        ownsRoot?.(candidate) !== false &&
        (!controller ||
          !ensureSubagentControllerOwnsRun({ cfg: params.cfg, controller, entry: candidate }));
      if (!ownerCurrent(entry, false) || !isCurrentSubagentRun(entry, params.cfg)) {
        continue;
      }
      selected.add(entry.childSessionKey);
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
      const { childSessionKey, requesterAgentId } = entry;
      const latest = () => getLatestOwnedSubagentRun(childSessionKey, requesterAgentId, params.cfg);
      const retirement = subagentRuns.captureRetirement(
        entry,
        (candidate) => latest() === candidate,
      );
      completeRetirementPublications.push(retirement.completePublication);
      releaseRetirements.push(retirement.release);
      const bind = (current: SubagentRunRecord): KillBinding => {
        const { generation, createdAt } = retirement.observation;
        const ownsRun = () =>
          retirement.observation.entry === current &&
          current.generation === generation &&
          current.createdAt === createdAt &&
          isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
          (subagentRuns.get(current.runId) === current ||
            retirement.observation.state === "retired");
        const isCurrent = (candidate: SubagentRunRecord, requirePreparedSession = true) =>
          retirement.observation.entry === candidate &&
          ownerCurrent(candidate, requirePreparedSession) &&
          isCurrentSubagentRun(candidate, params.cfg) &&
          (candidate !== current || ownsRun()) &&
          (!requirePreparedSession || ownsSessionIncarnation());
        const canTraverse = (requirePreparedSession = true) => {
          if (!ownerCurrent(current, requirePreparedSession) || !ownsRun()) {
            return false;
          }
          const replacement = latest();
          return (
            (replacement === current ||
              (retirement.observation.state === "retired" &&
                (!replacement || compareSubagentRunGeneration(replacement, current) < 0))) &&
            (!requirePreparedSession || ownsSessionIncarnation())
          );
        };
        return { entry: current, isCurrent, ownsRun, canTraverse };
      };
      const tree: KillTree = {
        ...bind(entry),
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
            session = await prepareSubagentKillSession(
              params.cfg,
              entry.childSessionKey,
              () => assertSubagentRegistryWriteSourceCurrent(stateContext),
              entry.execution.transcriptTarget,
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
    isParentCurrent?: (requirePreparedSession?: boolean) => boolean,
    ownsRoot?: (entry: SubagentRunRecord) => boolean,
  ) => {
    const pending: Array<{ tree: KillTree; prepare: () => Promise<void> }> = [];
    capture(pending, runs, trees, owner, isParentCurrent, ownsRoot);
    // Resident reservations can dispatch on the first await. Capture all known roots and
    // descendants first; persisted-only discovery below remains worker-owned.
    const resident = new Map(subagentRuns);
    for (const { tree } of pending) {
      const controller = {
        controllerSessionKey: tree.entry.childSessionKey,
        controllerAgentId: resolveSessionAgentId({
          config: params.cfg,
          sessionKey: tree.entry.childSessionKey,
        }),
      };
      capture(
        pending,
        listRunsForControllerFromRuns(resident, controller.controllerSessionKey),
        tree.children,
        controller,
        (prepared) => tree.canTraverse(prepared),
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
          controllerAgentId: resolveSessionAgentId({
            config: params.cfg,
            sessionKey: tree.entry.childSessionKey,
          }),
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
        );
        assertCurrent();
        await select(candidates, tree.children, controller, () => tree.canTraverse());
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
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    assertCurrent();
    const trees: KillTree[] = [];
    await select(params.runs, trees, params.controller, undefined, params.ownsRoot);
    const scope: KillScope = {
      cancellationControl,
      stateContext,
      refresh: async () => {
        for (const tree of trees) {
          await refreshTree(tree);
        }
        return selected.size;
      },
    };
    await scope.refresh();
    const result = await run(scope, trees);
    if (preparePublication) {
      do {
        await preparePublication.prepare();
      } while (preparePublication.needsPreparation());
    }
    if (publish) {
      assertCurrent();
    }
    outcome = { ok: true, value: publish ? publish(result, trees) : result };
  } catch (error) {
    outcome = { ok: false, error };
  }
  // Failed-launch cleanup may own the same provisional session. Let it proceed only
  // after cancellation publication finishes (including failure), before releasing a
  // scheduler hold that can itself await that cleanup.
  completeRetirementPublications.forEach((complete) => complete());
  const released = await Promise.allSettled(holds.map((reservation) => reservation.release()));
  const retired = await Promise.allSettled(releaseRetirements.map(async (release) => release()));
  releaseSessions.forEach((release) => release());
  if (!outcome.ok) {
    throw outcome.error;
  }
  for (const result of [...released, ...retired]) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  return outcome.value;
}
