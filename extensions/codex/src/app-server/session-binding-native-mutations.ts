/** Pure native metadata mutations, invoked inside the binding owner's transaction. */
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  mutateNativePendingAssignments,
  type CodexNativeSubagentPendingAssignment,
} from "./native-subagent-pending-assignments.js";
import {
  mutateCodexNativeSubagentSubmissions,
  type CodexNativeSubagentSubmission,
} from "./native-subagent-submission.js";
import {
  matchesCodexNativeSubagentSubmissionBinding,
  ownsStoredSessionGeneration,
  type CodexAppServerBindingIdentity,
  type StoredCodexAppServerBinding,
} from "./session-binding-record.js";

export type CodexNativeSubagentBindingMutation =
  | {
      kind: "record-native-subagent-assignment";
      owner: CodexNativeSubagentHistoryOwner;
      assignment: CodexNativeSubagentPendingAssignment;
    }
  | {
      kind: "consume-native-subagent-assignment";
      owner: CodexNativeSubagentHistoryOwner;
      assignment: CodexNativeSubagentPendingAssignment;
    }
  | {
      kind: "record-native-subagent-submission";
      owner: CodexNativeSubagentHistoryOwner;
      receipt: CodexNativeSubagentSubmission;
    }
  | {
      kind: "consume-native-subagent-submission";
      owner: CodexNativeSubagentHistoryOwner;
      receipt: CodexNativeSubagentSubmission;
    };

/** The caller supplies the transaction's freshly parsed row and current-authority closure. */
export function mutateNativeSubagentBinding({
  identity,
  current,
  mutation,
  assertCurrent,
}: {
  identity: CodexAppServerBindingIdentity;
  current: StoredCodexAppServerBinding | undefined;
  mutation: CodexNativeSubagentBindingMutation;
  assertCurrent: (() => void) | undefined;
}): { result: boolean; next?: StoredCodexAppServerBinding } {
  if (
    mutation.kind === "record-native-subagent-assignment" ||
    mutation.kind === "consume-native-subagent-assignment"
  ) {
    if (!assertCurrent) {
      throw new Error("Codex native assignment mutation requires current authority.");
    }
    assertCurrent();
    if (
      current?.state !== "active" ||
      !ownsStoredSessionGeneration(identity, current) ||
      (identity.kind === "session" && mutation.owner.sessionId !== identity.sessionId) ||
      !matchesCodexNativeSubagentSubmissionBinding(current.binding, mutation.owner)
    ) {
      return { result: false };
    }
    const changed = mutateNativePendingAssignments({
      current: current.nativeSubagentAssignments,
      owner: mutation.owner,
      assignment: mutation.assignment,
      consume: mutation.kind === "consume-native-subagent-assignment",
    });
    if (!changed.applied) {
      return { result: false };
    }
    const { nativeSubagentAssignments: _previous, ...bindingOwner } = current;
    return {
      result: true,
      next: {
        ...bindingOwner,
        ...(changed.next ? { nativeSubagentAssignments: changed.next } : {}),
      },
    };
  }
  if (!assertCurrent) {
    throw new Error("Codex native subagent submission mutation requires current authority.");
  }
  assertCurrent();
  if (
    current?.state !== "active" ||
    !ownsStoredSessionGeneration(identity, current) ||
    (identity.kind === "session" && mutation.owner.sessionId !== identity.sessionId) ||
    !matchesCodexNativeSubagentSubmissionBinding(current.binding, mutation.owner)
  ) {
    return { result: false };
  }
  const changed = mutateCodexNativeSubagentSubmissions({
    current: current.nativeSubagentSubmissions,
    owner: mutation.owner,
    receipt: mutation.receipt,
    consume: mutation.kind === "consume-native-subagent-submission",
  });
  if (!changed.applied) {
    return { result: false };
  }
  const { nativeSubagentSubmissions: _previous, ...bindingOwner } = current;
  return {
    result: true,
    next: {
      ...bindingOwner,
      ...(changed.next ? { nativeSubagentSubmissions: changed.next } : {}),
    },
  };
}
