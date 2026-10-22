import {
  createSessionProjection,
  reduceSessionProjection,
  type SessionProjectionEvent,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "./session-projection.js";

export const primaryScope: SessionProjectionScope = {
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

type Metadata = Record<string, unknown>;
function message(role: "user" | "assistant", text: string, metadata?: Metadata) {
  return { role, content: [{ type: "text", text }], ...(metadata ? { __openclaw: metadata } : {}) };
}

export const user = (text: string, metadata?: Metadata) => message("user", text, metadata);
export const assistant = (text: string, metadata?: Metadata) =>
  message("assistant", text, metadata);
export const savedUser = (text: string, id: string, seq: number, metadata?: Metadata) =>
  user(text, { id, seq, ...metadata });
export const savedReply = (text: string, id: string, seq: number, metadata?: Metadata) =>
  assistant(text, { id, seq, ...metadata });
export const prompt = (text: string, idempotencyKey: string) => user(text, { idempotencyKey });
export const projection = (messages: readonly unknown[] = []) =>
  createSessionProjection(primaryScope, messages);

type TerminalEvent = Extract<SessionProjectionEvent, { type: "runTerminal" }>;
export function terminal(
  state: SessionProjectionState,
  options: Omit<TerminalEvent, "type" | "runId" | "status"> &
    Partial<Pick<TerminalEvent, "runId" | "status">> = {},
) {
  return reduceSessionProjection(state, {
    type: "runTerminal",
    runId: "run-1",
    status: "completed",
    ...options,
  });
}
