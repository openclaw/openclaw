import type { EventType, Tool } from "@ag-ui/core";

export type EventWriter = (event: { type: EventType } & Record<string, unknown>) => void;

/**
 * Per-session store for:
 * 1. AG-UI client-provided tools (read by the plugin tool factory)
 * 2. SSE event writer (read by before/after_tool_call hooks)
 *
 * Fully reentrant — concurrent requests use different session keys.
 */
const toolStore = new Map<string, Tool[]>();
const writerStore = new Map<string, EventWriter>();

// --- Client tools (for the plugin tool factory) ---

export function stashTools(sessionKey: string, tools: Tool[]): void {
  console.log(`[clawg-ui] stashTools: sessionKey=${sessionKey}, toolCount=${tools.length}`);
  for (const t of tools) {
    console.log(`[clawg-ui]   tool: name=${t.name}, description=${t.description ?? "(none)"}, hasParams=${!!t.parameters}, params=${JSON.stringify(t.parameters ?? {})}`);
  }
  toolStore.set(sessionKey, tools);
}

export function popTools(sessionKey: string): Tool[] {
  const tools = toolStore.get(sessionKey) ?? [];
  console.log(`[clawg-ui] popTools: sessionKey=${sessionKey}, tools=${tools.length}`);
  toolStore.delete(sessionKey);
  return tools;
}

// --- SSE event writer (for before/after_tool_call hooks) ---

const messageIdStore = new Map<string, string>();

export function setWriter(
  sessionKey: string,
  writer: EventWriter,
  messageId: string,
): void {
  writerStore.set(sessionKey, writer);
  messageIdStore.set(sessionKey, messageId);
}

export function getWriter(sessionKey: string): EventWriter | undefined {
  return writerStore.get(sessionKey);
}

export function getMessageId(sessionKey: string): string | undefined {
  return messageIdStore.get(sessionKey);
}

export function clearWriter(sessionKey: string): void {
  writerStore.delete(sessionKey);
  messageIdStore.delete(sessionKey);
}

// --- Pending toolCallId stack (before_tool_call pushes, tool_result_persist pops) ---
// Only used for SERVER-side tools. Client tools emit TOOL_CALL_END in
// before_tool_call and never push to this stack.

const pendingStacks = new Map<string, string[]>();

export function pushToolCallId(sessionKey: string, toolCallId: string): void {
  let stack = pendingStacks.get(sessionKey);
  if (!stack) {
    stack = [];
    pendingStacks.set(sessionKey, stack);
  }
  stack.push(toolCallId);
  console.log(`[clawg-ui] pushToolCallId: sessionKey=${sessionKey}, toolCallId=${toolCallId}, stackSize=${stack.length}`);
}

export function popToolCallId(sessionKey: string): string | undefined {
  const stack = pendingStacks.get(sessionKey);
  const id = stack?.pop();
  console.log(`[clawg-ui] popToolCallId: sessionKey=${sessionKey}, toolCallId=${id ?? "none"}, stackSize=${stack?.length ?? 0}`);
  if (stack && stack.length === 0) {
    pendingStacks.delete(sessionKey);
  }
  return id;
}

// --- Client tool name tracking ---
// Tracks which tool names are client-provided so hooks can distinguish them.

const clientToolNames = new Map<string, Set<string>>();

export function markClientToolNames(
  sessionKey: string,
  names: string[],
): void {
  console.log(`[clawg-ui] markClientToolNames: sessionKey=${sessionKey}, names=${names.join(", ")}`);
  clientToolNames.set(sessionKey, new Set(names));
}

export function isClientTool(
  sessionKey: string,
  toolName: string,
): boolean {
  const result = clientToolNames.get(sessionKey)?.has(toolName) ?? false;
  console.log(`[clawg-ui] isClientTool: sessionKey=${sessionKey}, toolName=${toolName}, result=${result}`);
  return result;
}

export function clearClientToolNames(sessionKey: string): void {
  console.log(`[clawg-ui] clearClientToolNames: sessionKey=${sessionKey}`);
  clientToolNames.delete(sessionKey);
}

// --- Tool-fired-in-run flag ---
// Tracks whether any tool call (server or client) was emitted in the current
// run. When a text message is about to be emitted and this flag is set, the
// http-handler splits into a new run so tool events and text events live in
// separate runs (per AG-UI protocol best practice).

const toolFiredInRunFlags = new Map<string, boolean>();

export function setToolFiredInRun(sessionKey: string): void {
  toolFiredInRunFlags.set(sessionKey, true);
}

export function wasToolFiredInRun(sessionKey: string): boolean {
  return toolFiredInRunFlags.get(sessionKey) ?? false;
}

export function clearToolFiredInRun(sessionKey: string): void {
  toolFiredInRunFlags.delete(sessionKey);
}

// --- Client-tool-called flag ---
// Set when a client tool is invoked during a run so the dispatcher can
// suppress text output and end the run after the tool call events.

const clientToolCalledFlags = new Map<string, boolean>();

export function setClientToolCalled(sessionKey: string): void {
  console.log(`[clawg-ui] setClientToolCalled: sessionKey=${sessionKey}`);
  clientToolCalledFlags.set(sessionKey, true);
}

export function wasClientToolCalled(sessionKey: string): boolean {
  const result = clientToolCalledFlags.get(sessionKey) ?? false;
  console.log(`[clawg-ui] wasClientToolCalled: sessionKey=${sessionKey}, result=${result}`);
  return result;
}

export function clearClientToolCalled(sessionKey: string): void {
  console.log(`[clawg-ui] clearClientToolCalled: sessionKey=${sessionKey}`);
  clientToolCalledFlags.delete(sessionKey);
}

