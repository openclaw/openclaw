import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createPreparedNativeSessionBindingAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
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
  return {
    assertCurrent,
    assertCurrentAsync,
    read: async () => {
      const assignments =
        (await bindingStore.readNativeSubagentAssignments?.(identity, owner)) ?? [];
      await assertCurrentAsync();
      return assignments;
    },
    record: (assignment, assertSourceCurrent) =>
      bindingStore.mutate(
        identity,
        { kind: "record-native-subagent-assignment", owner, assignment },
        () => {
          assertCurrent();
          assertSourceCurrent();
        },
        params.authority,
      ),
    consume: async (assignment, assertSourceCurrent, undelivered) => {
      const assertRetirementCurrent = () => {
        assertCurrent();
        assertSourceCurrent();
      };
      const applied = await bindingStore.mutate(
        identity,
        {
          kind: "consume-native-subagent-assignment",
          owner,
          assignment,
          ...(undelivered ? { undelivered: true } : {}),
        },
        assertRetirementCurrent,
        params.authority,
      );
      if (applied && undelivered) {
        embeddedAgentLog.warn("Native subagent completion retired without delivery", {
          childThreadId: assignment.childThreadId,
          nativeTurnId: assignment.nativeTurnId,
          status: undelivered.status,
          childSessionKey: assignment.runId,
        });
        try {
          if (identity.kind !== "session" || !identity.sessionKey || !params.authority) {
            throw new Error("Native completion has no parent transcript authority.");
          }
          const note = await appendSessionTranscriptMessageByIdentityStrict({
            agentId: identity.agentId,
            sessionId: owner.sessionId,
            sessionKey: identity.sessionKey,
            preparation: { source: params.authority.prepared.source },
            updateMode: "inline",
            message: {
              role: "custom",
              customType: "openclaw.system-note",
              display: true,
              content:
                `Native subagent ${assignment.childThreadId} finished with status ${undelivered.status}, but its completion could not be delivered. Automatic delivery has stopped. Inspect its native Codex thread history${assignment.nativeTurnId ? ` at turn ${assignment.nativeTurnId}` : ""}; child session key: ${assignment.runId}.`.slice(
                  0,
                  2_048,
                ),
              timestamp: Date.now(),
              idempotencyKey: `codex-undelivered:${owner.lifecycleRevision ?? owner.sessionId}:${assignment.childThreadId}:${assignment.nativeTurnId ?? "initial"}`,
            },
          });
          if (note.kind !== "result") {
            throw new Error(`Native completion note was ${note.kind}.`);
          }
        } catch (error) {
          // A failed notice must never restart the retired completion's delivery.
          embeddedAgentLog.warn("Could not persist native completion retirement note", {
            childSessionKey: assignment.runId,
            error: formatErrorMessage(error),
          });
        }
      }
      return applied;
    },
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
