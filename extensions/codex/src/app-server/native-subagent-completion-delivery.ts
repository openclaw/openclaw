import { isDeepStrictEqual } from "node:util";
import { isDurableAgentHarnessCompletionDelivery } from "openclaw/plugin-sdk/agent-harness-completion";
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
import { delayForAttempt } from "./native-subagent-retry.js";
import type { CodexNativeSubagentSubmissionOwner } from "./native-subagent-submission-owner.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";
import { isJsonObject, type CodexThread, type CodexTurn } from "./protocol.js";

type CompletionDeliveryDependencies = {
  deliver: NativeSubagentMonitorRuntime["deliverAgentHarnessCompletion"];
  children: ReadonlyMap<string, ChildState>;
  parents: ReadonlyMap<string, ParentState>;
  retiredParents: Pick<WeakSet<ParentState>, "has">;
  /** A running sibling keeps this parent's subscription protected through the monitor. */
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

const COMPLETION_DELIVERY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const completionDeliveryOwners = new Map<string, ChildState>();

export class CodexNativeSubagentCompletionDelivery {
  private readonly recovering = new WeakSet<ChildState>();
  private readonly attempts = new Map<ChildState, Promise<void>>();

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
          return;
        }
        assertCurrent();
        const reader = (peer ??= open());
        removeClose ??= reader.addCloseHandler(() => closed.abort());
        await (initialized ??= reader.initialize());
        assertCurrent();
        if (!isDeepStrictEqual(identity, reader.getRuntimeIdentity())) {
          return;
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
          return;
        }
        assertCurrent();
        // Only a full read establishes activity. Quiet checks can preserve it until a conflicting status.
        if (includeTurns && result === "active" && !activityInvalidated) {
          observation.setRunning(assertCurrent);
        }
        if (typeof result !== "string") {
          if (this.claim(state, child)) {
            complete(state, child, result);
          }
          return;
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
      return;
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
        !child.nativeCompletionDelivered &&
        !child.cancellationRequested &&
        !this.recovering.has(child) &&
        this.isCurrent(state, child)
      ) {
        this.recovering.add(child);
        held.push({ child, spawnId, nativeTurnId, pendingCompletion });
      }
    }
    if (!held.length) {
      return;
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
              return;
            }
            const current = () =>
              ownsTurn() &&
              this.recovering.has(child) &&
              this.isCurrent(state, child) &&
              child.nativeTurnId === nativeTurnId &&
              child.pendingCompletion === pendingCompletion &&
              !child.cancellationRequested &&
              this.claim(state, child);
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

  deliverPending(state: ParentState, childState: ChildState): Promise<void> {
    const existing = this.attempts.get(childState);
    if (existing) {
      return existing;
    }
    // Publish the shared attempt before releasing a client can synchronously close it.
    const attempt = Promise.resolve().then(() => this.deliverAttempt(state, childState));
    this.attempts.set(childState, attempt);
    const release = () => {
      this.attempts.delete(childState);
    };
    void attempt.then(release, release);
    return attempt;
  }

  async join(child: ChildState): Promise<void> {
    await this.attempts.get(child);
  }

  private async deliverAttempt(state: ParentState, childState: ChildState): Promise<void> {
    const completion = childState.pendingCompletion;
    if (!completion || !this.isCurrent(state, childState)) {
      return;
    }
    if (childState.completionDeliveryTimer) {
      return;
    }
    let deferred = false;
    try {
      if (childState.cancellationRequested) {
        // Stop settles owned processes before acknowledging cancellation or
        // delivering a natural result that won the interruption race.
        return;
      }
      if (
        await this.dependencies.settleNestedCompletion(state, childState, () => {
          if (
            !this.isCurrent(state, childState) ||
            (childState.completionCustody && !childState.completionCustody.isCurrent())
          ) {
            throw new Error("Native completion acknowledgement is no longer current.");
          }
        })
      ) {
        this.dependencies.unregisterChild(childState);
        return;
      }
      if (!this.isCurrent(state, childState)) {
        return;
      }
      if (!this.prepareDelivery(state, childState)) {
        return;
      }
      if (childState.completionDeliveryAbandoned) {
        await this.abandon(state, childState);
        return;
      }
      // Foreground parents receive native completion input. A detached parent is
      // woken only after its last owner leaves and no running sibling still
      // protects it: the wake turn may have to release that subscription, which
      // the protection refuses. Releasing the last sibling re-drives held results;
      // native receipts deduplicate both paths.
      if (
        state.owners.size > 0 ||
        this.recovering.has(childState) ||
        !state.completionScope ||
        this.dependencies.isParentThreadRetained(state.parentThreadId)
      ) {
        deferred = state.owners.size > 0 || Boolean(state.completionScope);
        return;
      }
      const historyOwner = childState.historyOwner;
      const delivery = await this.dependencies.deliver({
        scope: state.completionScope,
        completionCustody: childState.completionCustody,
        ...(historyOwner
          ? {
              expectedRequester: {
                sessionId: historyOwner.sessionId,
                lifecycleRevision: historyOwner.lifecycleRevision,
              },
            }
          : {}),
        isSourceSessionAdmissionAllowed: () =>
          this.isCurrent(state, childState) && this.claim(state, childState),
        childSessionKey: childState.runId,
        childSessionId: completion.childThreadId,
        announceId: `codex-native:${childState.nativeParentThreadId}:${readCodexNativeSubagentRunId(childState.runId)?.turnId ? childState.runId : completion.childThreadId}:${completion.status}`,
        announceType: "Subagent",
        taskLabel: "Subagent",
        status: completion.status,
        statusLabel: completion.statusLabel,
        result: completion.result,
        replyInstruction:
          "Use the Codex native subagent result to continue or wrap up the parent task. If this is a Discord/channel session, send the visible response with the message tool instead of only writing a transcript final answer. Reply in your normal assistant voice and do not expose internal notification markup.",
      });
      if (!this.isCurrent(state, childState)) {
        return;
      }
      // Keep accepted delivery before a fallible ownership read. A retry cannot
      // deliver it again, including when a native receipt arrives during handoff.
      if (isDurableAgentHarnessCompletionDelivery(delivery)) {
        childState.nativeCompletionDelivered = true;
      }
      if (childState.nativeCompletionDelivered) {
        this.prepareDelivery(state, childState);
        return;
      }
      if (!this.claim(state, childState)) {
        this.dependencies.unregisterChild(childState);
        return;
      }
      if (delivery.recoveryBlocked) {
        await this.abandon(state, childState);
        return;
      }
      const error = delivery.error ?? "completion delivery did not produce a parent response";
      await this.scheduleRetry(state, childState, error);
    } catch (error) {
      if (!this.isCurrent(state, childState)) {
        return;
      }
      if (!this.claim(state, childState)) {
        this.dependencies.unregisterChild(childState);
        return;
      }
      const message = formatErrorMessage(error);
      await this.scheduleRetry(state, childState, message, !childState.completionDeliveryAbandoned);
      embeddedAgentLog.warn("Failed to deliver Codex native subagent completion", {
        parentThreadId: state.parentThreadId,
        childThreadId: completion.childThreadId,
        error: message,
      });
    } finally {
      if (!deferred) {
        // Keep the root through the first handoff, including a foreground parent's
        // pending unregister. Once attempted, sleeping retries retain only delivery authority.
        childState.completionCustody?.settleExecution();
      }
    }
  }

  finish(state: ParentState, child: ChildState): void {
    clearTimeout(child.completionDeliveryTimer);
    child.completionDeliveryTimer = undefined;
    void this.deliverPending(state, child);
  }

  applyReceipts(state: ParentState, runIds: readonly string[]): void {
    for (const runId of runIds) {
      const child = this.dependencies.children.get(runId);
      const deliveryParent = child && this.dependencies.parents.get(child.parentThreadId);
      if (
        !child ||
        !deliveryParent ||
        !this.isCurrent(state, child) ||
        this.dependencies.parents.get(deliveryParent.parentThreadId) !== deliveryParent ||
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
          // A rotated observer can receive an earlier assignment's result, but
          // its saved physical requester must match the observer and delivery owner.
          assertHistoryOwnerMatchesRegistration(
            child.historyOwner,
            state.historyOwner,
            child.nativeParentThreadId,
            true,
          );
        } catch {
          continue;
        }
        if (!this.claim(deliveryParent, child)) {
          continue;
        }
      }
      child.nativeCompletionDelivered = true;
      if (child.pendingCompletion && !this.attempts.has(child)) {
        this.finish(deliveryParent, child);
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

  release(childState: ChildState): void {
    childState.completionCustody?.release();
    clearTimeout(childState.completionDeliveryTimer);
    const deliveryOwnerKey = childState.deliveryOwnerKey;
    if (deliveryOwnerKey && completionDeliveryOwners.get(deliveryOwnerKey) === childState) {
      completionDeliveryOwners.delete(deliveryOwnerKey);
    }
    childState.deliveryOwnerKey = undefined;
  }

  private isCurrent(state: ParentState, child: ChildState): boolean {
    return (
      this.dependencies.children.get(child.runId) === child &&
      this.dependencies.parents.get(state.parentThreadId) === state &&
      !this.dependencies.retiredParents.has(state)
    );
  }

  private prepareDelivery(state: ParentState, child: ChildState): boolean {
    if (!child.pendingCompletion) {
      return false;
    }
    if (!this.claim(state, child) || !state.requesterSessionKey || !state.completionScope) {
      this.dependencies.unregisterChild(child);
      return false;
    }
    if (child.nativeCompletionDelivered) {
      child.pendingCompletion = undefined;
      this.dependencies.unregisterChild(child);
      return false;
    }
    this.dependencies.releaseClientRetentionIfIdle();
    return true;
  }

  private async abandon(state: ParentState, child: ChildState): Promise<void> {
    child.completionDeliveryAbandoned = true;
    try {
      await this.dependencies.abandon(state, child, () => {
        if (
          child.nativeCompletionDelivered ||
          !this.isCurrent(state, child) ||
          (child.completionCustody && !child.completionCustody.isCurrent()) ||
          (child.deliveryOwnerKey && completionDeliveryOwners.get(child.deliveryOwnerKey) !== child)
        ) {
          throw new Error("Native completion retirement is no longer current.");
        }
      });
      this.dependencies.unregisterChild(child);
    } catch (error) {
      if (this.isCurrent(state, child) && child.nativeCompletionDelivered) {
        this.prepareDelivery(state, child);
        return;
      }
      embeddedAgentLog.warn("Native completion retirement remains pending", {
        childThreadId: child.childThreadId,
        error: formatErrorMessage(error),
      });
      await this.scheduleRetry(state, child, formatErrorMessage(error), false);
    }
  }

  private async scheduleRetry(
    state: ParentState,
    childState: ChildState,
    error: string,
    chargeAttempt = true,
  ): Promise<void> {
    if (
      !childState.pendingCompletion ||
      childState.completionDeliveryTimer ||
      this.dependencies.children.get(childState.runId) !== childState
    ) {
      return;
    }
    if (
      chargeAttempt &&
      childState.completionDeliveryAttempt >= COMPLETION_DELIVERY_RETRY_DELAYS_MS.length
    ) {
      embeddedAgentLog.warn("Native subagent completion retries exhausted", {
        childThreadId: childState.childThreadId,
        error,
      });
      await this.abandon(state, childState);
      return;
    }
    const delayMs = delayForAttempt(
      COMPLETION_DELIVERY_RETRY_DELAYS_MS,
      chargeAttempt ? childState.completionDeliveryAttempt++ : childState.completionDeliveryAttempt,
    );
    childState.completionDeliveryTimer = setTimeout(() => {
      childState.completionDeliveryTimer = undefined;
      if (this.dependencies.children.get(childState.runId) !== childState) {
        return;
      }
      const currentParent = this.dependencies.parents.get(childState.parentThreadId);
      if (currentParent) {
        void this.deliverPending(currentParent, childState);
      }
    }, delayMs);
    childState.completionDeliveryTimer.unref();
  }

  private claim(state: ParentState, childState: ChildState): boolean {
    if (childState.completionCustody && !childState.completionCustody.isCurrent()) {
      return false;
    }
    const requesterSessionKey = state.requesterSessionKey?.trim();
    if (!requesterSessionKey) {
      return true;
    }
    const key =
      childState.deliveryOwnerKey ??
      `${requesterSessionKey}\0${childState.nativeTurnId ? codexNativeSubagentRunId(childState.childThreadId, childState.nativeTurnId) : childState.runId}`;
    try {
      state.assignmentStore?.assertCurrent();
      assertHistoryOwnerMatchesRegistration(
        childState.historyOwner,
        state.historyOwner,
        childState.nativeParentThreadId,
        state.historyOwner !== undefined,
      );
    } catch (error) {
      embeddedAgentLog.warn("Holding native completion with unresolved history owner", {
        childThreadId: childState.childThreadId,
        error: formatErrorMessage(error),
      });
      return false;
    }
    const owner = completionDeliveryOwners.get(key);
    if (owner) {
      return owner === childState;
    }
    // Delivery no longer needs the app-server client. Keep one process owner
    // across client replacement so fallback steering cannot inject twice.
    completionDeliveryOwners.set(key, childState);
    childState.deliveryOwnerKey = key;
    return true;
  }
}
