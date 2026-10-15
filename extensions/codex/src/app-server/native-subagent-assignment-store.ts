import { createPreparedNativeSessionBindingAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentAssignmentStore } from "./native-subagent-pending-assignments.js";
import type { CodexNativeSubagentSubmissionStore } from "./native-subagent-submission.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexBindingAuthority,
} from "./session-binding.js";

/** Accepted child writes retain the captured parent lifecycle beyond foreground settlement. */
export function createNativeSubagentSessionAuthority(
  parent: Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsync>> | undefined,
): CodexBindingAuthority | undefined {
  if (!parent) {
    return undefined;
  }
  return createPreparedNativeSessionBindingAuthority({
    lineage: [],
    source: parent.source,
    entryChecks: parent.entryCurrent ? [parent.entryCurrent] : [],
    assertCurrent: () => parent.source.assertScopeCurrent(),
  });
}

export function createNativeSubagentAssignmentStore(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  owner: CodexNativeSubagentHistoryOwner;
  assertLifecycleCurrent?: () => void;
  assertLifecycleCurrentAsync?: () => Promise<void>;
  authority?: CodexBindingAuthority;
}): CodexNativeSubagentAssignmentStore {
  const { bindingStore, identity, owner } = params;
  const assertCurrent = () => {
    params.assertLifecycleCurrent?.();
    const binding = bindingStore.read(identity);
    if (!binding || !matchesCodexNativeSubagentSubmissionBinding(binding, owner)) {
      throw new Error("Native assignment binding is no longer current.");
    }
  };
  const assertCurrentAsync = async () => {
    await params.assertLifecycleCurrentAsync?.();
    assertCurrent();
  };
  const mutate =
    (
      kind: "record-native-subagent-assignment" | "consume-native-subagent-assignment",
    ): CodexNativeSubagentAssignmentStore["record"] =>
    (assignment, assertSourceCurrent) =>
      bindingStore.mutate(
        identity,
        { kind, owner, assignment },
        () => {
          assertCurrent();
          assertSourceCurrent();
        },
        params.authority,
      );
  return {
    assertCurrent,
    assertCurrentAsync,
    read: async () => {
      const assignments =
        (await bindingStore.readNativeSubagentAssignments?.(identity, owner)) ?? [];
      await assertCurrentAsync();
      return assignments;
    },
    record: mutate("record-native-subagent-assignment"),
    consume: mutate("consume-native-subagent-assignment"),
  };
}

export function createNativeSubagentSubmissionStore(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  owner: CodexNativeSubagentHistoryOwner;
  assertLifecycleCurrentAsync: () => Promise<void>;
  authority?: CodexBindingAuthority;
}): CodexNativeSubagentSubmissionStore {
  const { bindingStore, identity, owner } = params;
  const assertCurrent = () => {
    const current = bindingStore.read(identity);
    if (!current || !matchesCodexNativeSubagentSubmissionBinding(current, owner)) {
      throw new Error("Native submission binding is no longer current.");
    }
  };
  return {
    assertCurrent,
    assertCurrentAsync: async () => {
      await params.assertLifecycleCurrentAsync();
      assertCurrent();
    },
    read: () => bindingStore.readNativeSubagentSubmissions(identity, owner),
    record: (receipt, assertSourceCurrent) =>
      bindingStore.mutate(
        identity,
        { kind: "record-native-subagent-submission", owner, receipt },
        assertSourceCurrent,
        params.authority,
      ),
    consume: (receipt, assertSourceCurrent) =>
      bindingStore.mutate(
        identity,
        { kind: "consume-native-subagent-submission", owner, receipt },
        assertSourceCurrent,
        params.authority,
      ),
  };
}
