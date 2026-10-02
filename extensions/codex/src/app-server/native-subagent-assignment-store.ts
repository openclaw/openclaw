import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
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
  return {
    assertCurrent,
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
