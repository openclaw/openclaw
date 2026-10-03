import type {
  Tool as OpenAITool,
  ResponseCreateParamsStreaming,
  ResponseInput,
} from "openai/resources/responses/responses.js";
import type { AiTransportHost } from "../host.js";
import {
  clearCodexWebSocketSseFallback,
  type CodexWebSocketAuthority,
  type CodexWebSocketSseFallbacks,
} from "./openai-chatgpt-responses-websocket-authority.js";

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

export interface RequestBody {
  model: string;
  store?: boolean;
  stream?: boolean;
  instructions?: string;
  previous_response_id?: string;
  input?: ResponseInput;
  tools?: OpenAITool[];
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
  temperature?: number;
  reasoning?: { effort?: string; summary?: string };
  service_tier?: ResponseCreateParamsStreaming["service_tier"];
  text?: ResponseCreateParamsStreaming["text"];
  include?: string[];
  prompt_cache_key?: string;
  [key: string]: unknown;
}

type WebSocketEventType = "open" | "message" | "error" | "close";
export type WebSocketListener = (event: unknown) => void;

export interface WebSocketLike {
  readonly readyState?: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

export interface CachedWebSocketContinuationState {
  lastRequestBody: RequestBody;
  lastResponseId: string;
  lastResponseItems: ResponseInput;
}

export interface CachedWebSocketConnection {
  socket: WebSocketLike;
  authority: CodexWebSocketAuthority;
  busy: boolean;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: CachedWebSocketContinuationState;
}

export interface OpenAICodexWebSocketRuntimeState {
  sessionCache: Map<string, CachedWebSocketConnection>;
  sseFallbacks: CodexWebSocketSseFallbacks;
}

const runtimeStates = new WeakMap<AiTransportHost, OpenAICodexWebSocketRuntimeState>();
const runtimeStateReferences = new Set<WeakRef<OpenAICodexWebSocketRuntimeState>>();
const runtimeStateFinalizer = new FinalizationRegistry<WeakRef<OpenAICodexWebSocketRuntimeState>>(
  (reference) => runtimeStateReferences.delete(reference),
);

export function getOpenAICodexWebSocketRuntimeState(
  transportHost: AiTransportHost,
): OpenAICodexWebSocketRuntimeState {
  let state = runtimeStates.get(transportHost);
  if (!state) {
    state = { sessionCache: new Map(), sseFallbacks: new Map() };
    runtimeStates.set(transportHost, state);
    const reference = new WeakRef(state);
    runtimeStateReferences.add(reference);
    runtimeStateFinalizer.register(state, reference, reference);
  }
  return state;
}

export function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
  try {
    socket.close(code, reason);
  } catch {}
}

export function isWebSocketReusable(socket: WebSocketLike): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
}

export function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
  return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

export function deleteOwnedWebSocketSession(
  state: OpenAICodexWebSocketRuntimeState,
  sessionId: string,
  entry: CachedWebSocketConnection,
): void {
  if (state.sessionCache.get(sessionId) === entry) {
    state.sessionCache.delete(sessionId);
  }
}

export function setOwnedWebSocketSession(
  state: OpenAICodexWebSocketRuntimeState,
  sessionId: string,
  entry: CachedWebSocketConnection,
  expected: CachedWebSocketConnection | undefined,
): boolean {
  if (state.sessionCache.get(sessionId) !== expected) {
    return false;
  }
  state.sessionCache.set(sessionId, entry);
  return true;
}

export function scheduleSessionWebSocketExpiry(
  state: OpenAICodexWebSocketRuntimeState,
  sessionId: string,
  entry: CachedWebSocketConnection,
): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) {
      return;
    }
    closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
    deleteOwnedWebSocketSession(state, sessionId, entry);
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

function closeRuntimeState(state: OpenAICodexWebSocketRuntimeState, sessionId?: string): void {
  const closeEntry = (entry: CachedWebSocketConnection) => {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    closeWebSocketSilently(entry.socket, 1000, "debug_close");
  };
  if (sessionId) {
    clearCodexWebSocketSseFallback(state.sseFallbacks, sessionId);
    const entry = state.sessionCache.get(sessionId);
    if (entry) {
      closeEntry(entry);
    }
    state.sessionCache.delete(sessionId);
    return;
  }
  for (const entry of state.sessionCache.values()) {
    closeEntry(entry);
  }
  state.sessionCache.clear();
  clearCodexWebSocketSseFallback(state.sseFallbacks);
}

export function closeOpenAICodexWebSocketState(
  transportHost: AiTransportHost,
  sessionId?: string,
): void {
  const state = runtimeStates.get(transportHost);
  if (state) {
    closeRuntimeState(state, sessionId);
  }
}

export function closeAllOpenAICodexWebSocketStates(sessionId?: string): void {
  for (const reference of runtimeStateReferences) {
    const state = reference.deref();
    if (!state) {
      runtimeStateReferences.delete(reference);
      continue;
    }
    closeRuntimeState(state, sessionId);
  }
}
