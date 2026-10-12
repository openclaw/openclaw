import type { PromptResponse, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.types.js";
import type { GatewayExecApprovalDecision } from "./permission-relay.js";

export type AcpDisconnectContext = {
  generation: number;
  reason: string;
};

export type AcpPendingPrompt = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
  idempotencyKey: string;
  sendAccepted?: boolean;
  disconnectContext?: AcpDisconnectContext;
  resolve: (response: PromptResponse) => void;
  reject: (err: Error) => void;
  sentText?: string;
  sentPreambles?: Map<string, string>;
  preambleNeedsSeparator?: boolean;
  preamblePreview?: { itemId: string; text: string; sent: string };
  sentThought?: string;
  streamMessage?: unknown;
  toolCalls?: Map<string, AcpPendingToolCall>;
};

export type AcpPendingApprovalRelay = {
  approvalId: string;
  runId: string;
  sessionId: string;
  state: "active" | "completed";
  /** User decision captured while the gateway was unreachable; replayed on reconnect. */
  pendingDecision?: GatewayExecApprovalDecision;
};

type AcpPendingToolCall = {
  kind: ToolKind;
  locations?: ToolCallLocation[];
  title: string;
};

export type AcpAgentWaitResult = {
  status?: "ok" | "error" | "timeout";
  error?: string;
  terminalReply?: AgentRunTerminalReplySnapshot;
};
