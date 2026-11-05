import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { GoalContinuation } from "../../auto-reply/reply/goal-continuation.types.js";
import {
  accountSessionGoalUsage,
  buildUpdatedSessionGoalStatus,
  SessionGoalTransitionError,
} from "../../config/sessions/goals-transitions.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { sameSessionTranscriptStorePath } from "../../config/sessions/transcript-store-identity.js";
import type { InternalSessionEntry, SessionGoal } from "../../config/sessions/types.js";
import { recordSessionGoalChanged } from "../../sessions/session-state-events.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OperationalRunInstanceRef } from "../operational-run-instance.js";
import type { AgentRunSessionTarget } from "../run-session-target.types.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import type { AgentHarnessNativeGoal } from "./native-goal.types.js";

type RequiredGoalOwner = {
  target: AgentRunSessionTarget;
  goal: AgentHarnessNativeGoal;
  updateStatus: (
    status: "complete" | "blocked",
    note?: string,
    assertToolCurrent?: SessionSourceAssertion,
  ) => Promise<SessionGoal>;
};

// HTTP tool calls restore this exact host-issued run object, not the CLI's async context.
// These are projections of the existing owner, never lookup by a caller-supplied run/session id.
const runGoalTools = resolveGlobalSingleton(
  Symbol.for("openclaw.runHostGoalTools"),
  () =>
    new WeakMap<
      OperationalRunInstanceRef,
      {
        target: AgentRunSessionTarget;
        updateStatus: (
          ...args: Parameters<RequiredGoalOwner["updateStatus"]>
        ) => Promise<SessionGoal | undefined>;
      }
    >(),
);

function bindRunGoalTool(
  instance: OperationalRunInstanceRef | undefined,
  target: AgentRunSessionTarget,
  signal: AbortSignal,
  assertCurrent: SessionSourceAssertion,
): (update: RequiredGoalOwner["updateStatus"]) => void {
  if (!instance) {
    return () => {};
  }
  let update: RequiredGoalOwner["updateStatus"] | undefined;
  const owner = {
    target: { ...target },
    updateStatus: async (
      status: "complete" | "blocked",
      note?: string,
      assertToolCurrent?: SessionSourceAssertion,
    ) => {
      assertCurrent();
      signal.throwIfAborted();
      if (runGoalTools.get(instance) !== owner) {
        throw new Error("Goal tool lost its native execution owner.");
      }
      return await update?.(status, note, assertToolCurrent);
    },
  };
  // Keep the closed assertion until this exact run is collected or its next attempt
  // binds: a late MCP call must not fall through to an unowned status write.
  runGoalTools.set(instance, owner);
  return (project) => {
    update = project;
  };
}

// Lexical projection of the execution's existing Goal owner, not another pursuit owner.
const requiredGoals = resolveGlobalSingleton(
  Symbol.for("openclaw.requiredHostGoal"),
  () => new AsyncLocalStorage<RequiredGoalOwner>(),
);

/** A freshly admitted turn must never inherit a predecessor's lexical Goal owner. */
export function withoutRequiredHostGoal<T>(run: () => T): T {
  return requiredGoals.exit(run);
}

/** Acquire before releasing the producer receipt, and retain through event settlement. */
export async function withRequiredHostGoal<T>(params: {
  target: AgentRunSessionTarget;
  identity: Readonly<GoalContinuation>;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  onAcquired: (assertExecutionCurrent: () => void, release: () => void) => void;
  onRevoked: (reason: unknown) => void;
  run: () => Promise<T>;
}): Promise<T> {
  const lifetime = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, lifetime.signal])
    : lifetime.signal;
  let goal: AgentHarnessNativeGoal | undefined;
  let assertExecutionCurrent: (() => void) | undefined;
  let updateStatus: RequiredGoalOwner["updateStatus"] | undefined;
  const revoke = () => params.onRevoked(goal?.signal.reason);
  let transferred = false;
  const release = () => {
    goal?.signal.removeEventListener("abort", revoke);
    lifetime.abort();
  };
  try {
    if (
      params.target.sessionId !== params.identity.sessionId ||
      params.target.expectedLifecycleRevision !== params.identity.lifecycleRevision
    ) {
      throw new Error("Required Goal execution changed its session incarnation.");
    }
    goal = await bindIndependentHostNativeGoal(
      params.target,
      params.assertCurrent,
      signal,
      (assertAcquired, update) => {
        assertExecutionCurrent = assertAcquired;
        updateStatus = update;
      },
    )();
    if (!goal || goal.id !== params.identity.goalId || !assertExecutionCurrent || !updateStatus) {
      throw new Error("Required Goal execution lost its active Goal.");
    }
    goal.assertCurrent();
    // This is the post-transfer execution fence. Own native completion retires its
    // row predicate without aborting this signal; external edits revoke it sticky.
    goal.signal.addEventListener("abort", revoke, { once: true });
    params.onAcquired(assertExecutionCurrent, release);
    transferred = true;
    assertExecutionCurrent();
    return await requiredGoals.run(
      { target: { ...params.target }, goal, updateStatus },
      params.run,
    );
  } finally {
    if (!transferred) {
      release();
    }
  }
}

/** The real Goal tool shares this execution's exact terminal transaction, not an external edit. */
export async function updateHostGoalFromTool(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  status: "complete" | "blocked";
  note?: string;
}): Promise<SessionGoal | undefined> {
  const caller = getGatewayToolCallerIdentity();
  const nativeOwner =
    caller?.operationalRunInstance && runGoalTools.get(caller.operationalRunInstance);
  const assertCaller = captureGatewayToolCallerAssertion();
  if (nativeOwner && !assertCaller) {
    throw new Error("Goal tool requires its admitted caller.");
  }
  assertCaller?.();
  const owner = nativeOwner ?? requiredGoals.getStore();
  if (!owner) {
    return undefined;
  }
  if (
    owner.target.agentId !== params.agentId ||
    owner.target.sessionKey !== params.sessionKey ||
    !sameSessionTranscriptStorePath(owner.target.storePath, params.storePath)
  ) {
    throw new Error("Goal tool changed its execution target.");
  }
  return owner.updateStatus(params.status, params.note, assertCaller);
}

/** Captured by the existing host capability owner, before handing mutable params to plugins. */
export function bindHostNativeGoal(
  target: AgentRunSessionTarget,
  assertCurrent: SessionSourceAssertion,
  ownerSignal: AbortSignal,
  operationalRunInstance?: OperationalRunInstanceRef,
): () => Promise<AgentHarnessNativeGoal | undefined> {
  const bindTool = bindRunGoalTool(operationalRunInstance, target, ownerSignal, assertCurrent);
  const owner = requiredGoals.getStore();
  if (
    !owner ||
    owner.target.agentId !== target.agentId ||
    owner.target.sessionKey !== target.sessionKey
  ) {
    return bindIndependentHostNativeGoal(target, assertCurrent, ownerSignal, (_assert, update) => {
      bindTool(update);
    });
  }
  // Only this exact execution target may borrow the acquired owner. Provider-facing
  // lifetime/assertions still apply, but native projection must not get a second observer.
  const assertBorrowed = () => {
    assertCurrent();
    ownerSignal.throwIfAborted();
    if (
      target.sessionId !== owner.target.sessionId ||
      target.expectedLifecycleRevision !== owner.target.expectedLifecycleRevision ||
      !sameSessionTranscriptStorePath(target.storePath, owner.target.storePath)
    ) {
      throw new Error("Native Goal preparation changed its execution target.");
    }
    owner.goal.assertCurrent();
  };
  const borrowed = Object.freeze({
    ...owner.goal,
    signal: AbortSignal.any([owner.goal.signal, ownerSignal]),
    assertCurrent: composeSessionSourceAssertion([assertCurrent], (assertSource) => {
      assertSource();
      assertBorrowed();
    }),
    readToolStatus() {
      assertBorrowed();
      return owner.goal.readToolStatus?.();
    },
    async onStatus(update: Parameters<AgentHarnessNativeGoal["onStatus"]>[0]) {
      assertBorrowed();
      await owner.goal.onStatus(update);
    },
  });
  // Built-in recovery uses the real tool without ever requesting a native capability.
  // Bind its already-acquired owner now, not only when a native adapter prepares.
  bindTool((status, note, assertToolCurrent) => {
    assertBorrowed();
    return owner.updateStatus(status, note, assertToolCurrent);
  });
  return async () => {
    assertBorrowed();
    return borrowed;
  };
}

function bindIndependentHostNativeGoal(
  target: AgentRunSessionTarget,
  assertCurrent: SessionSourceAssertion,
  ownerSignal: AbortSignal,
  onPrepared?: (
    assertExecutionCurrent: () => void,
    updateStatus: RequiredGoalOwner["updateStatus"],
  ) => void,
): () => Promise<AgentHarnessNativeGoal | undefined> {
  const { agentId, sessionId, sessionKey, storePath, expectedLifecycleRevision } = target;
  let prepared: Promise<AgentHarnessNativeGoal | undefined> | undefined;
  return () => {
    assertCurrent();
    ownerSignal.throwIfAborted();
    if (!agentId || !sessionId || !sessionKey || !storePath) {
      return Promise.resolve(undefined);
    }
    return (prepared ??= (async () => {
      const scope = { agentId, sessionKey, storePath };
      const controller = new AbortController();
      let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
      let revision = 0;
      let terminal: SessionGoal | undefined;
      let settled = false;
      let toolTerminal = false;
      let projecting = false;
      const release = () => {
        retained?.release();
        retained = undefined;
      };
      const revoke = (
        reason: unknown = new Error("The native goal no longer owns this session goal."),
      ) => {
        release();
        ownerSignal.removeEventListener("abort", onOwnerAbort);
        controller.abort(reason);
      };
      const onOwnerAbort = () => revoke(ownerSignal.reason);
      const assertOwner = () => {
        try {
          assertCurrent();
          ownerSignal.throwIfAborted();
          controller.signal.throwIfAborted();
        } catch (error) {
          revoke(error);
          throw error;
        }
      };
      const sameGoal = (
        before: InternalSessionEntry | undefined,
        after: InternalSessionEntry | undefined,
      ) =>
        (before === undefined && after === undefined) ||
        Boolean(
          before &&
          after &&
          before.sessionId === after.sessionId &&
          before.lifecycleRevision === after.lifecycleRevision &&
          before.archivedAt === after.archivedAt &&
          Boolean(before.abortedLastRun) === Boolean(after.abortedLastRun) &&
          ((!before.goal && !after.goal) ||
            (before.goal &&
              after.goal &&
              before.goal.id === after.goal.id &&
              before.goal.objective === after.goal.objective &&
              before.goal.tokenBudget === after.goal.tokenBudget &&
              (settled && toolTerminal
                ? terminal &&
                  isDeepStrictEqual(after.goal, {
                    ...terminal,
                    // Final accounting is not a new verdict. All control fields must
                    // still match this tool's exact committed terminal postimage.
                    tokenStart: after.goal.tokenStart,
                    tokenStartFresh: after.goal.tokenStartFresh,
                    tokensUsed: after.goal.tokensUsed,
                    continuationTurns: after.goal.continuationTurns,
                  })
                : after.goal.status === before.goal.status ||
                  (terminal && isDeepStrictEqual(after.goal, terminal))))),
        );
      ownerSignal.addEventListener("abort", onOwnerAbort, { once: true });
      try {
        assertOwner();
        const entry = await withSessionEntryReadOnlyInWorker(
          scope,
          assertOwner,
          async (read) => {
            if (!read.ok) {
              throw read.error;
            }
            if (retained && !retained.acknowledge(read.value, revision)) {
              throw new Error("The native goal changed during preparation.");
            }
            return read.value;
          },
          (_database, identity) => {
            // Subscribe before the asynchronous row read; never poll or read SQLite on callbacks.
            release();
            retained = retainPreparedSessionEntryPredicate({
              databaseIdentity: identity.key,
              sessionKey: resolveSqliteSessionKey(sessionKey, agentId),
              entry: undefined,
              acquiring: true,
              matches: sameGoal,
              onInvalidated: () => revoke(),
            });
            revision = retained.captureRevision();
          },
        );
        assertOwner();
        const goal = entry && accountSessionGoalUsage(entry, Date.now());
        if (
          !entry ||
          entry.sessionId !== sessionId ||
          entry.lifecycleRevision !== expectedLifecycleRevision ||
          !goal ||
          goal.status !== "active" ||
          entry.abortedLastRun ||
          entry.archivedAt
        ) {
          release();
          ownerSignal.removeEventListener("abort", onOwnerAbort);
          return undefined;
        }
        if (!retained) {
          throw new Error("Native goal execution requires a retained committed session row.");
        }
        const assertGoalCurrent = composeSessionSourceAssertion([assertCurrent], (assertSource) => {
          assertOwner();
          assertSource();
          if ((settled && !toolTerminal) || !retained?.isCurrent()) {
            throw new Error("The native goal no longer owns this session goal.");
          }
        });
        assertGoalCurrent();
        const projectStatus = async (
          update: Parameters<AgentHarnessNativeGoal["onStatus"]>[0],
          actor: { type: "system" | "agent"; id?: string },
          assertToolCurrent?: SessionSourceAssertion,
        ): Promise<SessionGoal> => {
          // Replacement writes consume explicit sources. Carry the exact HTTP/tool
          // caller through preparation and the worker's final commit grant too.
          const assertProjectionCurrent = composeSessionSourceAssertion([
            assertGoalCurrent,
            assertToolCurrent,
          ]);
          assertProjectionCurrent();
          if (settled) {
            // A native verdict following the real tool cannot overwrite its committed result.
            if (actor.type === "system" && terminal) {
              return { ...terminal };
            }
            throw new SessionGoalTransitionError("The goal is already terminal.");
          }
          if (update.status === "active") {
            return { ...goal };
          }
          if (projecting) {
            throw new Error("A native goal verdict is already being projected.");
          }
          projecting = true;
          try {
            const changed = await applySessionEntryReplacements({
              ...scope,
              sessionKeys: [sessionKey],
              requireWriteSuccess: true,
              assertCommitAllowed: assertProjectionCurrent,
              update: (rows) => {
                assertProjectionCurrent();
                const current = rows.find((row) => row.sessionKey === sessionKey)?.entry;
                if (!current || !sameGoal(entry, current) || current.goal?.status !== "active") {
                  throw new Error("The native goal no longer owns this session goal.");
                }
                const next = {
                  ...current,
                  goal: buildUpdatedSessionGoalStatus(
                    current,
                    {
                      status: update.status,
                      note: update.reason,
                    },
                    Date.now(),
                  ),
                };
                // Permit only this transaction's exact terminal postimage, not other verdicts.
                // Keep the observer armed until publication so a concurrent host Pause wins.
                terminal = next.goal;
                return { result: next, replacements: [{ sessionKey, entry: next }] };
              },
            });
            assertOwner();
            assertToolCurrent?.();
            toolTerminal = actor.type === "agent";
            settled = true;
            // Real tools finish before the native process/final reply. Keep exact postimage
            // custody until that owner ends so a later Stop, Pause or edit still revokes it.
            if (!toolTerminal) {
              release();
            }
            if (changed) {
              await recordSessionGoalChanged({
                sessionKey,
                agentId,
                entry: changed,
                actor,
                summary:
                  actor.type === "agent"
                    ? `goal status changed to ${update.status}`
                    : `native goal ${update.status}`,
              });
            }
            assertOwner();
            assertToolCurrent?.();
            if (!changed?.goal) {
              throw new Error("Goal terminal transaction returned no goal.");
            }
            return { ...changed.goal };
          } catch (error) {
            revoke(error);
            throw error;
          } finally {
            projecting = false;
          }
        };
        onPrepared?.(
          () => {
            // Do not recurse through source authority: the producer now delegates its
            // Goal check here. Source/placement/policy checks remain in its own assertion.
            ownerSignal.throwIfAborted();
            controller.signal.throwIfAborted();
            if (!settled && !retained?.isCurrent()) {
              throw new Error("Required Goal execution lost its committed row.");
            }
          },
          (status, note, assertToolCurrent) =>
            projectStatus(
              { status, reason: note },
              { type: "agent", id: sessionKey },
              assertToolCurrent,
            ),
        );
        return Object.freeze({
          version: 1 as const,
          id: goal.id,
          objective: goal.objective,
          ...(goal.tokenBudget !== undefined
            ? { tokenBudget: Math.max(0, goal.tokenBudget - goal.tokensUsed) }
            : {}),
          signal: controller.signal,
          assertCurrent: assertGoalCurrent,
          readToolStatus() {
            assertGoalCurrent();
            return toolTerminal &&
              (terminal?.status === "complete" || terminal?.status === "blocked")
              ? terminal.status
              : undefined;
          },
          async onStatus(update: Parameters<AgentHarnessNativeGoal["onStatus"]>[0]) {
            await projectStatus(update, { type: "system" });
          },
        });
      } catch (error) {
        revoke(error);
        throw error;
      }
    })());
  };
}
