import { registerAgentHarnessCompletion } from "openclaw/plugin-sdk/agent-harness-completion";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  codexNativeSubagentRunId,
  readCodexNativeSubagentRunId,
} from "./native-subagent-assignment.js";
import { assertHistoryOwnerMatchesRegistration } from "./native-subagent-history-owner.js";
import type {
  ChildState,
  NativeSubagentMonitorRuntime,
  ParentState,
  RecoveredCompletion,
} from "./native-subagent-monitor-types.js";

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
  constructor(private readonly dependencies: CompletionDeliveryDependencies) {}

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
          !state.requesterSessionKey ||
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
          await this.dependencies.abandon(state, child, assertCurrent);
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
