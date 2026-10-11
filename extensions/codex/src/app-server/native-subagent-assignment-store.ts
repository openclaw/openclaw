import {
  codexNativeSubagentHistoryConnectionFingerprint,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentAssignmentStore } from "./native-subagent-pending-assignments.js";
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
}): CodexNativeSubagentAssignmentStore {
  const { bindingStore, identity, owner } = params;
  const assertCurrent = () => {
    params.assertLifecycleCurrent?.();
    const binding = bindingStore.read(identity);
    if (!binding || !matchesCodexNativeSubagentSubmissionBinding(binding, owner)) {
      throw new Error("Native assignment binding is no longer current.");
    }
  };
  const assertDeliveryOwner = () => {
    params.assertLifecycleCurrent?.();
    const binding = bindingStore.read(identity);
    if (binding?.threadId === owner.parentThreadId) {
      assertCurrent();
      return;
    }
    // Completion can outlive its native parent, not its physical requester or
    // connection. Assignment reads and writes still require the original thread.
    if (
      !params.assertLifecycleCurrent ||
      identity.kind !== "session" ||
      identity.sessionId !== owner.sessionId ||
      !binding ||
      binding.pendingSupervisionBranch ||
      codexNativeSubagentHistoryConnectionFingerprint(binding) !== owner.connectionFingerprint
    ) {
      throw new Error("Native completion delivery owner is no longer current.");
    }
  };
  const mutate =
    (
      kind: "record-native-subagent-assignment" | "consume-native-subagent-assignment",
    ): CodexNativeSubagentAssignmentStore["record"] =>
    (assignment, assertSourceCurrent) =>
      bindingStore.mutate(identity, { kind, owner, assignment }, () => {
        assertCurrent();
        assertSourceCurrent();
      });
  return {
    assertCurrent,
    assertDeliveryOwner,
    read: async () => {
      const assignments =
        (await bindingStore.readNativeSubagentAssignments?.(identity, owner)) ?? [];
      assertCurrent();
      return assignments;
    },
    record: mutate("record-native-subagent-assignment"),
    consume: mutate("consume-native-subagent-assignment"),
  };
}
