import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";

/** Names-only admission: 2.5% of the model window at four code units per token. */
export function assertDeferredToolInventoryFits(params: {
  names: readonly string[];
  contextTokens: number;
  model?: string;
  contextSource?: string;
}): void {
  const requiredSize = params.names.join(", ").length;
  const limit = Math.floor(params.contextTokens / 10);
  if (requiredSize <= limit) {
    return;
  }
  const message = `Deferred tool inventory exceeds its budget: toolCount=${params.names.length}, requiredSize=${requiredSize}, limit=${limit}, sizeUnit=utf16-code-units, contextTokens=${params.contextTokens}, contextSource=${params.contextSource ?? "unspecified"}, model=${params.model ?? "unspecified"}.`;
  const userMessage = `Codex did not start this turn: the names of its ${params.names.length} enabled tools exceed the budget for tool names in this context window. Enable fewer tools for this agent, use a larger context window, or set plugins.entries.codex.config.codexDynamicToolsLoading to "direct".`;
  // The names contract stops this turn rather than retrying another model or
  // restoring full schemas. An unscoped preflight is the host's global stop.
  throw Object.assign(new AgentHarnessPreflightError(message, { userMessage }), {
    code: "TOOL_INVENTORY_BUDGET_EXCEEDED",
    toolCount: params.names.length,
    requiredSize,
    limit,
    sizeUnit: "utf16-code-units",
  });
}
