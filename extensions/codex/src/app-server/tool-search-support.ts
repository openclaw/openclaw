// Codex tool_search capability gate.
//
// OpenAI's nano-tier models (e.g. `gpt-5.4-nano`, `gpt-5.5-nano`) reject the
// `tool_search` tool family with a 400 `invalid_request_error`. The codex
// harness must omit these tools from the dynamic tool list when the active
// model does not support them. Mirrors the `supportsModelTools` capability-
// gate pattern in src/agents/model-tool-support.ts.

const NANO_MODEL_ID_PATTERN = /^gpt-.*-nano(?:[-:.@].*)?$/i;

const TOOL_SEARCH_FAMILY_NAMES = new Set([
  "tool_search",
  "tool_search_code",
  "tool_describe",
  "tool_call",
]);

export function isToolSearchSupported(modelId: string | undefined): boolean {
  if (typeof modelId !== "string" || modelId.trim() === "") {
    return true;
  }
  return !NANO_MODEL_ID_PATTERN.test(modelId.trim());
}

export function filterToolsForToolSearchSupport<T extends { name?: string }>(
  tools: T[],
  params: { modelId: string | undefined },
): T[] {
  if (isToolSearchSupported(params.modelId)) {
    return tools;
  }
  return tools.filter((tool) => !TOOL_SEARCH_FAMILY_NAMES.has(tool.name ?? ""));
}
