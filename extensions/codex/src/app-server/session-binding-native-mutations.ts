import { codexNativeSubagentRunId } from "./native-subagent-assignment.js";
/** Pure native metadata mutations, invoked inside the binding owner's transaction. */
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  mutateNativePendingAssignments,
  type CodexNativeSubagentPendingAssignment,
} from "./native-subagent-pending-assignments.js";
import {
  mutateCodexNativeSubagentSubmissions,
  readCodexNativeSubagentSubmissions,
  matchesCodexNativeSubagentSubmissionOwner,
  type CodexNativeSubagentSubmission,
  type CodexNativeSubagentSubmissions,
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
      undelivered?: true;
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
  const isAssignment =
    mutation.kind === "record-native-subagent-assignment" ||
    mutation.kind === "consume-native-subagent-assignment";
  if (!assertCurrent) {
    const operation = isAssignment ? "assignment" : "subagent submission";
    throw new Error(`Codex native ${operation} mutation requires current authority.`);
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
  if (isAssignment) {
    const changed = mutateNativePendingAssignments({
      current: current.nativeSubagentAssignments,
      owner: mutation.owner,
      assignment: mutation.assignment,
      consume: mutation.kind === "consume-native-subagent-assignment",
    });
    if (!changed.applied) {
      // A committed retirement can lose its reply; absence settles only this current owner.
      return {
        result:
          mutation.kind === "consume-native-subagent-assignment" &&
          mutation.undelivered === true &&
          changed.absent === true,
      };
    }
    const { nativeSubagentAssignments: _previous, ...bindingOwner } = current;
    const retired = changed.consumed;
    if (retired && mutation.kind === "consume-native-subagent-assignment" && mutation.undelivered) {
      let submissions: CodexNativeSubagentSubmissions | undefined;
      try {
        submissions = readCodexNativeSubagentSubmissions(bindingOwner.nativeSubagentSubmissions);
      } catch {
        // Preserve unreadable receipts without keeping a terminal assignment alive.
      }
      if (
        submissions &&
        matchesCodexNativeSubagentSubmissionOwner(submissions.owner, mutation.owner)
      ) {
        const receipts = submissions.receipts.filter(
          (receipt) =>
            receipt.childThreadId !== retired.childThreadId ||
            (receipt.submissionId !== retired.nativeTurnId &&
              codexNativeSubagentRunId(receipt.childThreadId, receipt.submissionId) !==
                retired.runId),
        );
        delete bindingOwner.nativeSubagentSubmissions;
        if (receipts.length) {
          bindingOwner.nativeSubagentSubmissions = { ...submissions, receipts };
        }
      }
    }
    return {
      result: true,
      next: {
        ...bindingOwner,
        ...(changed.next ? { nativeSubagentAssignments: changed.next } : {}),
      },
    };
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
