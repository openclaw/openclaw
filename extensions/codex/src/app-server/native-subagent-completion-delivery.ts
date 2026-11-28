import { isDeepStrictEqual } from "node:util";
import { registerAgentHarnessCompletion } from "openclaw/plugin-sdk/agent-harness-completion";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { CodexAppServerClient } from "./client.js";
import {
  type CodexNativeSubagentAssignmentInventory,
  watchDetachedSubmission,
} from "./native-subagent-assignment-inventory.js";
import {
  codexNativeSubagentRunId,
  readCodexNativeSubagentRunId,
} from "./native-subagent-assignment.js";
import { assertHistoryOwnerMatchesRegistration } from "./native-subagent-history-owner.js";
import { initialWaitReceipt, readDetachedSuccessor } from "./native-subagent-history-recovery.js";
import type {
  ChildState,
  NativeSubagentMonitorRuntime,
  ParentOwner,
  ParentState,
  RecoveredCompletion,
} from "./native-subagent-monitor-types.js";
import {
  DEFAULT_RECOVERY_POLL_DELAYS_MS,
  logRecoveryFailure,
} from "./native-subagent-recovery-coordinator.js";
import type { CodexNativeSubagentSubmissionOwner } from "./native-subagent-submission-owner.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";
import { isJsonObject, type CodexThread, type CodexTurn } from "./protocol.js";

type CompletionDeliveryDependencies = {
  deliver: NativeSubagentMonitorRuntime["deliverAgentHarnessCompletion"];
  children: ReadonlyMap<string, ChildState>;
  parents: ReadonlyMap<string, ParentState>;
  retiredParents: Pick<WeakSet<ParentState>, "has">;
  isParentThreadRetained: (parentThreadId: string) => boolean;
  unregisterChild: (child: ChildState) => void;
  abandon: (state: ParentState, child: ChildState, assertCurrent: () => void) => Promise<void>;
  settleNestedCompletion: (
    state: ParentState,
    child: ChildState,
    assertCurrent: () => void,
  ) => Promise<boolean>;
  releaseClientRetentionIfIdle: () => void;
};

/** Translates native lineage and subscription facts for the core completion owner. */
export class CodexNativeSubagentCompletionDelivery {
  private readonly recovering = new WeakSet<ChildState>();

  constructor(private readonly dependencies: CompletionDeliveryDependencies) {}

  async settleAfterClose(options: {
    closed?: CodexAppServerClient;
    held?: ReadonlyMap<ChildState, CodexNativeSubagentSubmission>;
    parents: ParentState[];
    submissions: CodexNativeSubagentSubmissionOwner;
    assignments: CodexNativeSubagentAssignmentInventory;
    finish: () => void;
    complete: (state: ParentState, child: ChildState, result: RecoveredCompletion) => Promise<void>;
  }) {
    const { parents, submissions, assignments, closed, held, finish, complete } = options;
    const drain = (state: ParentState) =>
      Promise.allSettled([submissions.drain(state), assignments.drain(state)]);
    const pending = parents.some(
      (state) => assignments.hasWrites(state) || submissions.hasCustody(state),
    );
    // Register detached reads before yielding to any replacement registration.
    const finished = pending ? Promise.all(parents.map(drain)).then(finish) : finish();
    const recovery =
      closed && held?.size
        ? this.recoverDetached(closed, held, finished, (state, child, result) => {
            void complete(state, child, result).catch((error: unknown) =>
              logRecoveryFailure(child.childThreadId, error),
            );
          })
        : undefined;
    if (finished) {
      await finished;
    }
    // Removed parents can release their binding guards while unrelated workers run.
    const settlements = parents.map(async (state) => {
      if (recovery && this.dependencies.parents.get(state.parentThreadId) === state) {
        await recovery;
      }
      await drain(state);
      if (this.dependencies.parents.get(state.parentThreadId) !== state) {
        state.submissionStore?.release?.();
      }
    });
    await Promise.all([recovery, ...settlements]);
  }

  // A disconnected subscription can lose the final event after the parent has
  // detached. Read only the exact accepted successor, without resuming either thread.
  private async recoverDetached(
    client: CodexAppServerClient,
    held: ReadonlyMap<ChildState, CodexNativeSubagentSubmission>,
    finished: Promise<void> | void,
    complete: (state: ParentState, child: ChildState, completion: RecoveredCompletion) => void,
  ) {
    const open = client.getDisconnectedPeer();
    const identity = client.getRuntimeIdentity();
    const closed = new AbortController();
    let peer: CodexAppServerClient | undefined;
    let initialized: Promise<void> | undefined;
    let removeClose: (() => void) | undefined;
    const recover = async (child: ChildState, receipt: CodexNativeSubagentSubmission) => {
      const state = this.dependencies.parents.get(child.parentThreadId);
      using observation = state && watchDetachedSubmission(state, receipt, client.getInstanceId());
      await finished;
      const store = state?.assignmentStore;
      const custody = child.completionCustody;
      if (!open || !identity || !store || !state?.historyOwner || !custody || !observation) {
        return;
      }
      const deadline = new AbortController();
      const signal = AbortSignal.any([
        deadline.signal,
        custody.signal,
        closed.signal,
        observation.signal,
      ]);
      const assertCurrent = () => {
        signal.throwIfAborted();
        store.assertCurrent();
        if (
          !this.isCurrent(state, child) ||
          !custody.isCurrent() ||
          state.assignmentStore !== store ||
          state.historyOwner?.parentThreadId !== child.parentThreadId ||
          !isDeepStrictEqual(state.historyOwner, child.historyOwner) ||
          child.childThreadId !== receipt.childThreadId ||
          child.nativeTurnId !== receipt.submissionId ||
          child.terminal ||
          child.subscriptionClosed ||
          child.cancellationRequested ||
          child.cancelledModelTurnId === receipt.submissionId
        ) {
          throw new Error("Disconnected native submission is no longer current.");
        }
      };
      const pending = async () =>
        (await store.read()).some(
          (entry) =>
            entry.runId === child.runId &&
            entry.nativeParentThreadId === state.parentThreadId &&
            !entry.recordedCompletion &&
            isDeepStrictEqual(entry.owner, child.historyOwner) &&
            isDeepStrictEqual(entry.submission, receipt),
        );
      let idle = createDeferred<boolean>();
      let activityInvalidated = false;
      let removeHandler: (() => void) | undefined;
      const read = async (includeTurns: boolean) => {
        assertCurrent();
        if (!(await pending())) {
          return undefined;
        }
        assertCurrent();
        const reader = (peer ??= open());
        removeClose ??= reader.addCloseHandler(() => closed.abort());
        await (initialized ??= reader.initialize());
        assertCurrent();
        if (!isDeepStrictEqual(identity, reader.getRuntimeIdentity())) {
          return undefined;
        }
        // Codex broadcasts status without a subscription. Latch hints before
        // reading so an overlapping completion cannot leave us waiting.
        removeHandler ??= reader.addNotificationHandler(({ method, params }) => {
          if (
            method === "thread/status/changed" &&
            isJsonObject(params) &&
            params.threadId === child.childThreadId &&
            isJsonObject(params.status) &&
            (params.status.type === "idle" ||
              params.status.type === "notLoaded" ||
              params.status.type === "systemError")
          ) {
            activityInvalidated = true;
            observation.setRunning();
            if (params.status.type !== "systemError") {
              idle.resolve(true);
            }
          }
        });
        const { thread } = await reader.request(
          "thread/read",
          { threadId: child.childThreadId, includeTurns },
          { signal, assertCurrent },
        );
        assertCurrent();
        const result = readDetachedSuccessor(thread, state.parentThreadId, receipt, includeTurns);
        if (result !== "active") {
          observation.setRunning();
        }
        if (!result || !(await pending())) {
          return undefined;
        }
        assertCurrent();
        // Only a full read establishes activity. Quiet checks can preserve it until a conflicting status.
        if (includeTurns && result === "active" && !activityInvalidated) {
          observation.setRunning(assertCurrent);
        }
        if (typeof result !== "string") {
          if (this.hasHistoryOwner(state, child)) {
            complete(state, child, result);
          }
          return undefined;
        }
        return result;
      };
      let includeTurns = true;
      let reread = false;
      const options = { signal, ref: false };
      const quietMs = Math.max(...DEFAULT_RECOVERY_POLL_DELAYS_MS);
      try {
        while (!signal.aborted) {
          const status = await raceWithTimeout(
            () => read(includeTurns),
            10_000,
            () => deadline.abort(),
            options,
          );
          if (!status) {
            return;
          }
          if (status === "reread") {
            if (reread) {
              return;
            }
            reread = true;
            continue;
          }
          // Bound silence on a dead socket without repeatedly fetching all turns.
          includeTurns =
            status === "idle" ||
            (await raceWithTimeout(idle.promise, quietMs, () => false, options));
          idle = createDeferred<boolean>();
          activityInvalidated = false;
        }
      } finally {
        removeHandler?.();
      }
    };
    try {
      await Promise.allSettled(
        [...held].map(async ([child, receipt]) => {
          try {
            await recover(child, receipt);
          } catch (error) {
            logRecoveryFailure(child.childThreadId, error);
          } finally {
            if (!child.terminal && this.dependencies.children.get(child.runId) === child) {
              this.dependencies.unregisterChild(child);
            }
          }
        }),
      );
    } finally {
      removeClose?.();
      peer?.close();
    }
  }

  // Close handlers run synchronously in either order. Reserve only pending
  // results before the queued detached attempt can admit a wake.
  holdInitialWait(state: ParentState, owner: ParentOwner, ownsTurn: () => boolean) {
    if (!owner.spawnCalls) {
      return undefined;
    }
    const held = [];
    for (const child of this.dependencies.children.values()) {
      const spawnId = owner.spawnCalls.get(child);
      const { nativeTurnId, pendingCompletion } = child;
      if (
        spawnId &&
        nativeTurnId &&
        child.terminal &&
        pendingCompletion?.status === "succeeded" &&
        child.runId === codexNativeSubagentRunId(child.childThreadId) &&
        child.parentThreadId === state.parentThreadId &&
        child.nativeParentThreadId === state.parentThreadId &&
        !child.completionDelivery?.isConsumed() &&
        !child.cancellationRequested &&
        !this.recovering.has(child) &&
        this.isCurrent(state, child)
      ) {
        this.recovering.add(child);
        held.push({ child, spawnId, nativeTurnId, pendingCompletion });
      }
    }
    if (!held.length) {
      return undefined;
    }
    const children = held;
    return {
      read: async (
        turn: CodexTurn,
        readChild: (id: string, assertCurrent: () => void) => Promise<CodexThread>,
      ) => {
        const receipts = await Promise.allSettled(
          children.map(async (entry) => {
            const { child, spawnId, nativeTurnId, pendingCompletion } = entry;
            if (
              !ownsTurn() ||
              turn.id !== owner.turnId ||
              !turn.items?.some(
                (item) =>
                  item.tool === "wait" &&
                  Array.isArray(item.receiverThreadIds) &&
                  item.receiverThreadIds.includes(child.childThreadId),
              )
            ) {
              return undefined;
            }
            const current = () =>
              ownsTurn() &&
              this.recovering.has(child) &&
              this.isCurrent(state, child) &&
              child.nativeTurnId === nativeTurnId &&
              child.pendingCompletion === pendingCompletion &&
              !child.completionDelivery?.isConsumed() &&
              !child.cancellationRequested &&
              this.hasHistoryOwner(state, child);
            const thread = await readChild(child.childThreadId, () => {
              if (!current()) {
                throw new Error("Codex wait recovery is no longer current");
              }
            });
            const receipt = await initialWaitReceipt(
              async () => turn,
              state.parentThreadId,
              thread,
              nativeTurnId,
              pendingCompletion,
              spawnId,
            );
            return receipt && { child, receipt, current };
          }),
        );
        return () => {
          for (const result of receipts) {
            if (result.status !== "fulfilled" || !result.value) {
              continue;
            }
            const { child, receipt, current } = result.value;
            if (current() && child.deliveryReceipts.observe([receipt]).includes(child.runId)) {
              this.applyReceipts(state, [child.runId]);
            }
          }
        };
      },
      [Symbol.dispose]: () => {
        for (const { child } of children) {
          this.recovering.delete(child);
          void this.join(child).then(() => this.deliverPending(state, child));
        }
      },
    };
  }

  deliverPending(state: ParentState, child: ChildState): Promise<void> {
    if (!child.pendingCompletion || !this.isCurrent(state, child)) {
      return Promise.resolve();
    }
    const registration = this.registration(state, child);
    if (!registration) {
      // Stop still owns process cleanup when this child has no completion scope.
      if (!child.cancellationRequested) {
        this.dependencies.unregisterChild(child);
      }
      return Promise.resolve();
    }
    child.completionDelivery ??= registerAgentHarnessCompletion(registration);
    return child.completionDelivery.complete(child.pendingCompletion);
  }

  async join(child: ChildState): Promise<void> {
    await child.completionDelivery?.waitForDelivery();
  }

  applyReceipts(state: ParentState, runIds: readonly string[]): void {
    for (const runId of runIds) {
      const child = this.dependencies.children.get(runId);
      const deliveryParent = child && this.dependencies.parents.get(child.parentThreadId);
      if (
        !child ||
        !deliveryParent ||
        !this.isCurrent(state, child) ||
        this.dependencies.retiredParents.has(deliveryParent)
      ) {
        continue;
      }
      if (deliveryParent !== state) {
        if (
          !state.requesterSessionKey?.trim() ||
          state.requesterSessionKey !== deliveryParent.requesterSessionKey
        ) {
          continue;
        }
        try {
          assertHistoryOwnerMatchesRegistration(
            child.historyOwner,
            state.historyOwner,
            child.nativeParentThreadId,
            true,
          );
        } catch {
          continue;
        }
        if (!this.hasHistoryOwner(deliveryParent, child)) {
          continue;
        }
      }
      const registration = this.registration(deliveryParent, child);
      if (registration) {
        child.completionDelivery ??= registerAgentHarnessCompletion(registration);
        child.completionDelivery.consume();
      }
    }
  }

  deliverDetached(state: ParentState): void {
    for (const child of this.dependencies.children.values()) {
      if (child.parentThreadId === state.parentThreadId && child.pendingCompletion) {
        void this.deliverPending(state, child);
      }
    }
  }

  reset(child: ChildState): void {
    child.completionDelivery?.release();
    child.completionDelivery = undefined;
  }

  release(child: ChildState): void {
    child.completionCustody?.release();
    child.completionDelivery?.release();
  }

  private isCurrent(state: ParentState, child: ChildState): boolean {
    return (
      this.dependencies.children.get(child.runId) === child &&
      this.dependencies.parents.get(state.parentThreadId) === state &&
      !this.dependencies.retiredParents.has(state)
    );
  }

  private hasHistoryOwner(state: ParentState, child: ChildState): boolean {
    if (child.completionCustody && !child.completionCustody.isCurrent()) {
      return false;
    }
    try {
      state.assignmentStore?.assertCurrent();
      assertHistoryOwnerMatchesRegistration(
        child.historyOwner,
        state.historyOwner,
        child.nativeParentThreadId,
        state.historyOwner !== undefined,
      );
      return true;
    } catch (error) {
      embeddedAgentLog.warn("Holding native completion with unresolved history owner", {
        childThreadId: child.childThreadId,
        error: formatErrorMessage(error),
      });
      return false;
    }
  }

  private registration(state: ParentState, child: ChildState) {
    const scope = state.completionScope;
    if (!scope || !state.requesterSessionKey) {
      return undefined;
    }
    const completionCustody = child.completionCustody;
    return {
      scope,
      assignmentId: child.nativeTurnId
        ? codexNativeSubagentRunId(child.childThreadId, child.nativeTurnId)
        : child.runId,
      isCurrent: () => this.isCurrent(state, child),
      readiness: (): "ready" | "waiting" | "blocked" | "unavailable" => {
        if (child.cancellationRequested) {
          return "blocked";
        }
        if (!this.hasHistoryOwner(state, child)) {
          return "unavailable";
        }
        return state.owners.size > 0 ||
          this.recovering.has(child) ||
          this.dependencies.isParentThreadRetained(state.parentThreadId)
          ? "waiting"
          : "ready";
      },
      observeConsumption: async (assertCurrent: () => void) => {
        const consumed = await this.dependencies.settleNestedCompletion(state, child, () => {
          assertCurrent();
          if (completionCustody && !completionCustody.isCurrent()) {
            throw new Error("Native completion acknowledgement is no longer current.");
          }
        });
        if (!consumed) {
          assertCurrent();
          if (this.hasHistoryOwner(state, child)) {
            // Closing a retired one-shot client releases its foreground owner.
            this.dependencies.releaseClientRetentionIfIdle();
          }
        }
        return consumed;
      },
      deliver: (completion: RecoveredCompletion, assertCurrent: () => void) => {
        const completionIdentity = readCodexNativeSubagentRunId(child.runId)?.turnId
          ? child.runId
          : child.nativeTurnId
            ? codexNativeSubagentRunId(completion.childThreadId, child.nativeTurnId)
            : completion.childThreadId;
        return this.dependencies.deliver({
          scope,
          completionCustody,
          isSourceSessionAdmissionAllowed: () => {
            try {
              assertCurrent();
              return this.hasHistoryOwner(state, child);
            } catch {
              return false;
            }
          },
          childSessionKey: child.runId,
          childSessionId: completion.childThreadId,
          announceId: `codex-native:${child.nativeParentThreadId}:${completionIdentity}:${completion.status}`,
          announceType: "Subagent",
          taskLabel: "Subagent",
          status: completion.status,
          statusLabel: completion.statusLabel,
          result: completion.result,
          replyInstruction:
            "Use the Codex native subagent result to continue or wrap up the parent task. If this is a Discord/channel session, send the visible response with the message tool instead of only writing a transcript final answer. Reply in your normal assistant voice and do not expose internal notification markup.",
        });
      },
      retire: async (
        outcome: "consumed" | "undelivered" | "unavailable",
        assertCurrent: () => void,
      ) => {
        if (outcome === "undelivered") {
          await this.dependencies.abandon(state, child, () => {
            assertCurrent();
            if (!this.hasHistoryOwner(state, child)) {
              throw new Error("Native completion retirement is no longer current.");
            }
          });
        } else if (outcome === "consumed") {
          child.pendingCompletion = undefined;
        }
        this.dependencies.unregisterChild(child);
      },
      settleExecution: () => completionCustody?.settleExecution(),
      onError: (error: unknown) =>
        embeddedAgentLog.warn("Native completion remains pending", {
          childThreadId: child.childThreadId,
          error: formatErrorMessage(error),
        }),
    };
  }
}
