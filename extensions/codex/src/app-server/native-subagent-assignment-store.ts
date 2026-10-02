import {
  codexNativeSubagentHistoryConnectionFingerprint,
  matchesCodexNativeSubagentHistoryOwner,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import {
  CodexNativeCompletionOwnerError,
  type CodexNativeSubagentAssignmentStore,
} from "./native-subagent-pending-assignments.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
} from "./session-binding.js";

export function createNativeSubagentAssignmentStore(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  owner: CodexNativeSubagentHistoryOwner;
  assertLifecycleCurrent?: () => void;
  /**
   * Fresh read of the parent OpenClaw session. Undefined means it cannot be
   * read, so a rotated binding cannot be proven to belong to this owner.
   */
  readParentSession?: () => { sessionId?: string; lifecycleRevision?: string } | undefined;
}): CodexNativeSubagentAssignmentStore {
  const { bindingStore, identity, owner } = params;
  const assertCurrent = () => {
    params.assertLifecycleCurrent?.();
    const binding = bindingStore.read(identity);
    if (!binding || !matchesCodexNativeSubagentSubmissionBinding(binding, owner)) {
      throw new Error("Native assignment binding is no longer current.");
    }
  };
  // Delivery-only: a completion may follow native parent rotation when the
  // session, lifecycle revision, and connection are unchanged (the same rule
  // automatic history recovery uses). Writes and receipts stay strict.
  const assertDeliveryOwner = () => {
    const session = params.readParentSession?.();
    // Same lifecycle rule as the submission store's parent-session assertion.
    if (
      session &&
      owner.lifecycleRevision !== undefined &&
      session.lifecycleRevision !== owner.lifecycleRevision
    ) {
      throw new CodexNativeCompletionOwnerError("lifecycle-changed", false);
    }
    const binding = bindingStore.read(identity);
    if (!binding) {
      throw new CodexNativeCompletionOwnerError("binding-unavailable", true);
    }
    if (binding.pendingSupervisionBranch) {
      throw new CodexNativeCompletionOwnerError("pending-supervision-branch", true);
    }
    const connectionFingerprint = codexNativeSubagentHistoryConnectionFingerprint(binding);
    if (connectionFingerprint !== owner.connectionFingerprint) {
      throw new CodexNativeCompletionOwnerError("connection-changed", false);
    }
    if (binding.threadId === owner.parentThreadId) {
      // Unrotated: exactly the strict submission-binding check.
      assertCurrent();
      return;
    }
    // Rotation is accepted only for a session-owned binding whose physical
    // session is freshly proven to be the owner's.
    if (!session || identity.kind !== "session") {
      throw new CodexNativeCompletionOwnerError("rotation-unverifiable", false);
    }
    if (session.sessionId !== owner.sessionId || identity.sessionId !== owner.sessionId) {
      throw new CodexNativeCompletionOwnerError("session-changed", false);
    }
    const rotatedOwner: CodexNativeSubagentHistoryOwner = {
      parentThreadId: binding.threadId,
      sessionId: session.sessionId,
      ...(session.lifecycleRevision ? { lifecycleRevision: session.lifecycleRevision } : {}),
      connectionFingerprint,
    };
    if (!matchesCodexNativeSubagentHistoryOwner(owner, rotatedOwner)) {
      throw new CodexNativeCompletionOwnerError("lifecycle-changed", false);
    }
  };
  return {
    assertCurrent,
    assertDeliveryOwner,
    read: () => {
      assertCurrent();
      return bindingStore.readNativeSubagentAssignments?.(identity, owner) ?? [];
    },
    record: (assignment, assertSourceCurrent) =>
      bindingStore.mutate(
        identity,
        { kind: "record-native-subagent-assignment", owner, assignment },
        () => {
          assertCurrent();
          assertSourceCurrent();
        },
      ),
    consume: (assignment, assertSourceCurrent) =>
      bindingStore.mutate(
        identity,
        { kind: "consume-native-subagent-assignment", owner, assignment },
        () => {
          assertCurrent();
          assertSourceCurrent();
        },
      ),
  };
}
