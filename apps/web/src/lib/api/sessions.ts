/**
 * Session API functions for interacting with the Clawdbrain gateway.
 *
 * These functions provide a typed interface for:
 * - Listing sessions for an agent
 * - Getting session details and chat history
 * - Sending messages to a session
 * - Managing session lifecycle
 */

import { getGatewayClient } from "./gateway-client";

// Session types

export interface GatewaySessionRow {
  key: string;
  label?: string;
  tags?: string[];
  lastMessageAt?: number;
  messageCount?: number;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  derivedTitle?: string;
  lastMessage?: string;
}

export interface SessionsListResult {
  ts: number;
  path: string;
  count: number;
  defaults: {
    mainKey?: string;
    thinkingLevel?: string;
  };
  sessions: GatewaySessionRow[];
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  input?: string;
  output?: string;
  duration?: string;
  progress?: number;
}

export interface ChatHistoryResult {
  messages: ChatMessage[];
  thinkingLevel?: string | null;
}

export interface ChatSendParams {
  sessionKey: string;
  message: string;
  deliver?: boolean;
  idempotencyKey: string;
  attachments?: Array<{
    type: "image";
    mimeType: string;
    content: string;
  }>;
}

export interface ChatSendResult {
  ok: boolean;
  runId?: string;
}

export interface SessionPatchParams {
  key: string;
  label?: string | null;
  tags?: string[] | null;
  thinkingLevel?: string | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
}

// Chat event types for real-time updates

export type ChatEventState = "delta" | "final" | "aborted" | "error";

export interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  state: ChatEventState;
  kind?: "text" | "reasoning";
  message?: unknown;
  errorMessage?: string;
}

export interface AgentEventPayload {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  /** Often present (added by gateway runtime), but not guaranteed by schema. */
  sessionKey?: string;
}

// Session API functions

/**
 * List all sessions, optionally filtered
 */
export async function listSessions(options?: {
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  includeLastMessage?: boolean;
  includeDerivedTitles?: boolean;
  activeMinutes?: number;
  limit?: number;
}): Promise<SessionsListResult> {
  const client = getGatewayClient();
  return client.request<SessionsListResult>("sessions.list", {
    includeGlobal: options?.includeGlobal ?? false,
    includeUnknown: options?.includeUnknown ?? false,
    includeLastMessage: options?.includeLastMessage ?? true,
    includeDerivedTitles: options?.includeDerivedTitles ?? true,
    activeMinutes: options?.activeMinutes,
    limit: options?.limit ?? 50,
  });
}

/**
 * Get chat history for a session
 */
export async function getChatHistory(
  sessionKey: string,
  limit = 100
): Promise<ChatHistoryResult> {
  const client = getGatewayClient();
  return client.request<ChatHistoryResult>("chat.history", {
    sessionKey,
    limit,
  });
}

/**
 * Send a message to a session
 */
export async function sendChatMessage(params: ChatSendParams): Promise<ChatSendResult> {
  const client = getGatewayClient();
  return client.request<ChatSendResult>("chat.send", {
    sessionKey: params.sessionKey,
    message: params.message,
    deliver: params.deliver ?? true,
    idempotencyKey: params.idempotencyKey,
    attachments: params.attachments,
  });
}

/**
 * Abort a running chat
 */
export async function abortChat(
  sessionKey: string,
  runId?: string
): Promise<{ ok: boolean }> {
  const client = getGatewayClient();
  return client.request("chat.abort", { sessionKey, runId });
}

/**
 * Update session metadata
 */
export async function patchSession(params: SessionPatchParams): Promise<{ ok: boolean }> {
  const client = getGatewayClient();
  return client.request("sessions.patch", params);
}

/**
 * Delete a session
 */
export async function deleteSession(
  key: string,
  deleteTranscript = false
): Promise<{ ok: boolean }> {
  const client = getGatewayClient();
  return client.request("sessions.delete", { key, deleteTranscript });
}

// Session key helpers

/**
 * Build an agent-scoped session key
 */
export function buildAgentSessionKey(agentId: string, mainKey = "main"): string {
  return `agent:${agentId}:${mainKey}`;
}

/**
 * Parse an agent session key
 */
export function parseAgentSessionKey(key: string): { agentId: string; mainKey: string } | null {
  const match = key.match(/^agent:([^:]+):(.+)$/);
  if (!match) {return null;}
  return { agentId: match[1], mainKey: match[2] };
}

/**
 * Find sessions for a specific agent
 */
export function filterSessionsByAgent(
  sessions: GatewaySessionRow[],
  agentId: string
): GatewaySessionRow[] {
  const prefix = `agent:${agentId.toLowerCase()}:`;
  return sessions.filter((s) => s.key.toLowerCase().startsWith(prefix));
}
