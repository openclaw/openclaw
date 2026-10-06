import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { codexNativeSubagentRunId } from "./native-subagent-assignment.js";
import type {
  ChildState,
  ParentOwner,
  ParentState,
  ThreadRecovery,
} from "./native-subagent-monitor-types.js";
import {
  matchesNativeAssignmentLifecycle,
  type CodexNativeSubagentPendingAssignment,
} from "./native-subagent-pending-assignments.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";

/** Pending locators live with the existing binding, not in a parallel task ledger. */
export class CodexNativeSubagentAssignmentInventory {
  private readonly writes = new Map<ParentState, Promise<void>>();
  private readonly snapshots = new WeakMap<ChildState, string>();

  constructor(
    private readonly dependencies: {
      assertCurrent: (state: ParentState) => void;
      isCurrent: (state: ParentState) => boolean;
      readHistory: (
        assignment: CodexNativeSubagentPendingAssignment,
      ) => Promise<ThreadRecovery | undefined>;
      restore: (
        state: ParentState,
        assignment: CodexNativeSubagentPendingAssignment,
        recovery: ThreadRecovery,
        custody: AgentHarnessCompletionCustody,
      ) => Promise<void>;
      onSettled: (state: ParentState) => void;
    },
  ) {}

  hasWrites(state: ParentState): boolean {
    return this.writes.has(state);
  }

  async drain(state: ParentState): Promise<void> {
    while (this.writes.has(state)) {
      await this.writes.get(state);
    }
  }

  /** New inference authority may escape only after its exact locator commits. */
  recordExecution(
    state: ParentState,
    assignment: CodexNativeSubagentPendingAssignment,
    assertCurrent: () => void,
  ): Promise<void> {
    const store = state.assignmentStore;
    if (!store) {
      throw new Error("Native model execution has no assignment persistence owner.");
    }
    return this.enqueue(state, async () => {
      const assertAdmission = () => {
        this.dependencies.assertCurrent(state);
        assertCurrent();
      };
      assertAdmission();
      if (!(await store.record(assignment, assertAdmission))) {
        throw new Error("Native model execution assignment was not persisted.");
      }
      assertAdmission();
    });
  }

  recordSubmission(
    state: ParentState,
    submission: CodexNativeSubagentSubmission,
    nativeParentThreadId: string,
  ): void {
    if (!state.historyOwner || !state.assignmentStore) {
      return;
    }
    const assignment: CodexNativeSubagentPendingAssignment = {
      runId: codexNativeSubagentRunId(submission.childThreadId, submission.submissionId),
      childThreadId: submission.childThreadId,
      nativeTurnId: submission.submissionId,
      nativeParentThreadId,
      owner: state.historyOwner,
      submission,
    };
    void this.enqueue(state, async () => {
      if (
        !(await state.assignmentStore?.record(assignment, () =>
          this.dependencies.assertCurrent(state),
        ))
      ) {
        throw new Error("Native submission inventory binding changed before persistence.");
      }
    });
  }

  record(state: ParentState, child: ChildState): void {
    const assignment = this.fact(child);
    if (
      !assignment ||
      !state.assignmentStore ||
      child.nativeCompletionDelivered ||
      child.subscriptionClosed
    ) {
      return;
    }
    const snapshot = JSON.stringify(assignment);
    if (this.snapshots.get(child) === snapshot) {
      return;
    }
    this.snapshots.set(child, snapshot);
    void this.enqueue(state, async () => {
      try {
        const applied = await state.assignmentStore?.record(assignment, () =>
          this.dependencies.assertCurrent(state),
        );
        if (!applied) {
          throw new Error("Native assignment binding changed before persistence.");
        }
      } catch (error) {
        this.snapshots.delete(child);
        throw error;
      }
    });
  }

  settle(state: ParentState, child: ChildState): void {
    const assignment = this.fact(child);
    // Disconnection, interrupted execution, and an exhausted delivery retry do
    // not acknowledge the result. Leave their durable locators for registration.
    if (
      !assignment ||
      !state.assignmentStore ||
      (!child.nativeCompletionDelivered && (!child.subscriptionClosed || child.pendingCompletion))
    ) {
      return;
    }
    void this.enqueue(state, async () => {
      await state.assignmentStore?.consume(assignment, () =>
        this.dependencies.assertCurrent(state),
      );
    });
  }

  async restore(state: ParentState, owner: ParentOwner): Promise<void> {
    const store = state.assignmentStore;
    const current = state.historyOwner;
    // Matching IDs identify history, not permission to resume delivery. Capture
    // a fresh host-issued capability at registration before any asynchronous read.
    if (!store || !current || !owner.completionCustody?.isCurrent()) {
      return;
    }
    const custody = owner.completionCustody.retain();
    try {
      store.assertCurrent();
      for (const assignment of store.read()) {
        if (!matchesNativeAssignmentLifecycle(assignment.owner, current)) {
          continue;
        }
        const recovery = await this.dependencies.readHistory(assignment);
        if (!this.dependencies.isCurrent(state) || !custody.isCurrent()) {
          return;
        }
        store.assertCurrent();
        if (!recovery || recovery.parentThreadId !== assignment.nativeParentThreadId) {
          continue;
        }
        await this.dependencies.restore(state, assignment, recovery, custody);
      }
    } catch (error) {
      embeddedAgentLog.warn("Native pending assignments remain for reconciliation", {
        error: formatErrorMessage(error),
      });
    } finally {
      custody.release();
    }
  }

  private fact(child: ChildState): CodexNativeSubagentPendingAssignment | undefined {
    return child.historyOwner
      ? {
          runId: child.runId,
          childThreadId: child.childThreadId,
          ...(child.nativeTurnId ? { nativeTurnId: child.nativeTurnId } : {}),
          nativeParentThreadId: child.nativeParentThreadId,
          owner: child.historyOwner,
        }
      : undefined;
  }

  private enqueue(state: ParentState, operation: () => Promise<void>): Promise<void> {
    const recorded = (this.writes.get(state) ?? Promise.resolve()).then(operation);
    const pending = recorded.catch((error: unknown) => {
      embeddedAgentLog.warn("Native assignment durability could not be updated", {
        error: formatErrorMessage(error),
      });
    });
    this.writes.set(state, pending);
    void pending.then(() => {
      if (this.writes.get(state) === pending) {
        this.writes.delete(state);
      }
      this.dependencies.onSettled(state);
    });
    // Observation keeps its warning/settlement path; execution admission awaits
    // the original acknowledgment, so the queue's catch cannot grant authority.
    return recorded;
  }
}
