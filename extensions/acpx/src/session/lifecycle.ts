import { normalizeRuntimeSessionId } from "../runtime-session-id.js";
import type { SessionConversation, SessionRecord } from "../runtime-types.js";
import type { AgentLifecycleSnapshot } from "../transport/acp-client.js";

export function applyLifecycleSnapshotToRecord(
  record: SessionRecord,
  snapshot: AgentLifecycleSnapshot,
): void {
  record.pid = snapshot.pid;
  record.agentStartedAt = snapshot.startedAt;

  if (snapshot.lastExit) {
    record.lastAgentExitCode = snapshot.lastExit.exitCode;
    record.lastAgentExitSignal = snapshot.lastExit.signal;
    record.lastAgentExitAt = snapshot.lastExit.exitedAt;
    record.lastAgentDisconnectReason = snapshot.lastExit.reason;
    return;
  }

  record.lastAgentExitCode = undefined;
  record.lastAgentExitSignal = undefined;
  record.lastAgentExitAt = undefined;
  record.lastAgentDisconnectReason = undefined;
}

export function reconcileAgentSessionId(
  record: SessionRecord,
  agentSessionId: string | undefined,
): void {
  const normalized = normalizeRuntimeSessionId(agentSessionId);
  if (!normalized) {
    return;
  }

  record.agentSessionId = normalized;
}

export function sessionHasAgentMessages(record: SessionRecord): boolean {
  return record.messages.some(
    (message) => typeof message === "object" && message !== null && "Agent" in message,
  );
}

export function applyConversation(record: SessionRecord, conversation: SessionConversation): void {
  record.title = conversation.title;
  record.messages = conversation.messages;
  record.updated_at = conversation.updated_at;
  record.cumulative_token_usage = conversation.cumulative_token_usage;
  record.request_token_usage = conversation.request_token_usage;
}
