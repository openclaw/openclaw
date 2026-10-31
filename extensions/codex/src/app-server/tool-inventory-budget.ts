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
  // The names contract stops this turn rather than retrying another model or
  // restoring full schemas. An unscoped preflight is the host's global stop.
  throw Object.assign(new AgentHarnessPreflightError(message, { userMessage: message }), {
    code: "TOOL_INVENTORY_BUDGET_EXCEEDED",
    toolCount: params.names.length,
    requiredSize,
    limit,
    sizeUnit: "utf16-code-units",
  });
}
