/**
 * Protocol type definitions for the OpenClaw ↔ voiceNode WebSocket bridge.
 *
 * Every message is JSON with a `type` discriminator, `id` (UUID), and `timestamp` (ISO 8601).
 */

// ── Authentication ──────────────────────────────────────────────────

export interface AuthMessage {
  type: "auth";
  id: string;
  timestamp: string;
  token: string;
  client: string;
  version: string;
  capabilities: string[];
}

export interface AuthResult {
  type: "auth_result";
  id: string;
  timestamp: string;
  success: boolean;
  sessionId?: string;
  error?: string;
}

// ── Chat (voiceNode → OpenClaw agent) ───────────────────────────────

export interface ChatRequest {
  type: "chat.request";
  id: string;
  timestamp: string;
  content: string;
  context: {
    tenantId: string;
    userId: string;
    personaId?: string;
    sessionId?: string;
  };
}

export interface ChatResponseDelta {
  type: "chat.response.delta";
  id: string;
  timestamp: string;
  requestId: string;
  delta: string;
  index: number;
  done: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChatResponse {
  type: "chat.response";
  id: string;
  timestamp: string;
  requestId: string;
  content: string;
  done: true;
  metadata?: Record<string, unknown>;
}

// ── Tool Calls (OpenClaw agent → voiceNode) ─────────────────────────

export interface ToolCall {
  type: "tool.call";
  id: string;
  timestamp: string;
  toolName: string;
  arguments: Record<string, unknown>;
  context: {
    tenantId: string;
    userId: string;
    requestId: string;
  };
}

export interface ToolResult {
  type: "tool.result";
  id: string;
  timestamp: string;
  callId: string;
  result: {
    success: boolean;
    data?: unknown;
    error?: string;
  };
}

// ── Keepalive ───────────────────────────────────────────────────────

export interface Ping {
  type: "ping";
  id: string;
  timestamp: string;
}

export interface Pong {
  type: "pong";
  id: string;
  timestamp: string;
}

// ── Error ───────────────────────────────────────────────────────────

export type ErrorCode =
  | "AUTH_FAILED"
  | "AUTH_REQUIRED"
  | "TOOL_NOT_FOUND"
  | "TOOL_EXECUTION_ERROR"
  | "AGENT_ERROR"
  | "TIMEOUT"
  | "INVALID_MESSAGE";

export interface ErrorMessage {
  type: "error";
  id: string;
  timestamp: string;
  requestId?: string;
  code: ErrorCode;
  message: string;
}

// ── Union Type ──────────────────────────────────────────────────────

export type BridgeMessage =
  | AuthMessage
  | AuthResult
  | ChatRequest
  | ChatResponseDelta
  | ChatResponse
  | ToolCall
  | ToolResult
  | Ping
  | Pong
  | ErrorMessage;
