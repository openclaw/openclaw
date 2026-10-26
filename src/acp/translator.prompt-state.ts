import type { PromptResponse, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.types.js";
import type { GatewayExecApprovalDecision } from "./permission-relay.js";

export type AcpDisconnectContext = {
  generation: number;
  reason: string;
};

/**
 * Streaming state shared by pending prompts and prompt-less background runs.
 * Tracks what has already been emitted so incremental gateway events are
 * forwarded as deltas instead of full replays.
 */
export type AcpStreamContext = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
  /** Gateway run id; also the ledger recording key for emitted updates. */
  idempotencyKey: string;
  sentText?: string;
  sentPreambles?: Map<string, string>;
  preambleNeedsSeparator?: boolean;
  preamblePreview?: { itemId: string; text: string; sent: string };
  sentThought?: string;
  streamMessage?: unknown;
  toolCalls?: Map<string, AcpPendingToolCall>;
};

export type AcpPendingPrompt = AcpStreamContext & {
  sendAccepted?: boolean;
  disconnectContext?: AcpDisconnectContext;
  resolve: (response: PromptResponse) => void;
  reject: (err: Error) => void;
};

/**
 * Streaming state for a gateway run with no pending ACP prompt, such as a
 * sub-agent completion waking the requester session after its turn ended.
 * Updates are forwarded as plain session/update notifications; there is no
 * session/prompt response to settle.
 */
export type AcpBackgroundRun = AcpStreamContext;

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
  stopReason?: string;
  error?: string;
  terminalReply?: AgentRunTerminalReplySnapshot;
};
