//#region src/infra/agent-events.d.ts
type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | "item" | "plan" | "approval" | "command_output" | "patch" | "compaction" | "thinking" | (string & {});
type AgentApprovalEventPhase = "requested" | "resolved";
type AgentApprovalEventStatus = "pending" | "unavailable" | "approved" | "denied" | "failed";
type AgentApprovalEventKind = "exec" | "plugin" | "unknown";
type AgentApprovalEventData = {
  phase: AgentApprovalEventPhase;
  kind: AgentApprovalEventKind;
  status: AgentApprovalEventStatus;
  title: string;
  itemId?: string;
  toolCallId?: string;
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  host?: string;
  reason?: string;
  scope?: "turn" | "session";
  message?: string;
};
type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};
declare function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">): void;
declare function onAgentEvent(listener: (evt: AgentEventPayload) => void): () => void;
declare function resetAgentEventsForTest(): void;
//#endregion
export { onAgentEvent as a, emitAgentEvent as i, AgentEventPayload as n, resetAgentEventsForTest as o, AgentEventStream as r, AgentApprovalEventData as t };