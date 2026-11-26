import type { AgentTool } from "./types.js";

type ToolListContext = { tools?: AgentTool[] };

/** Tools a run loaded for itself; they survive continuations that resend the session's tool list. */
const loadedTools = new WeakSet<AgentTool>();

/** Add a tool to a run context once and return it; later provider requests in the run send it. */
export function append<T extends AgentTool | undefined>(context: ToolListContext, tool: T): T {
  if (tool && !context.tools?.some((existing) => existing.name === tool.name)) {
    context.tools = [...(context.tools ?? []), tool];
  }
  return tool;
}

/** Load a tool for the rest of the run, such as an on-demand tool the model just looked up. */
export function load(context: ToolListContext, tool: AgentTool): void {
  loadedTools.add(tool);
  append(context, tool);
}

/** Keep the tools a run loaded for itself when a continuation replaces the context's tool list. */
export function keepLoaded<T extends ToolListContext>(next: T | undefined, previous: T): T {
  if (!next) {
    return previous;
  }
  const kept = (previous.tools ?? []).filter(
    (tool) => loadedTools.has(tool) && !next.tools?.some((existing) => existing.name === tool.name),
  );
  return kept.length > 0 ? { ...next, tools: [...(next.tools ?? []), ...kept] } : next;
}
