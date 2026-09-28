import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

/**
 * Resolves the model's own final message text for diagnostic capture. Only the
 * text of the model's last message counts, including sentinels such as
 * NO_REPLY: message-tool send text, earlier turn text the runner substituted
 * for an empty last message, delivery output, and host or hook text are never
 * returned. Blocked and hook-handled turns never ran a model; errored runs may
 * retain genuine partial model output and keep it.
 */
export function resolveDiagnosticModelResponse(result: EmbeddedAgentRunResult): string | undefined {
  // Hook-handled turns record providerStarted: false; no model produced text.
  if (
    result.meta.livenessState === "blocked" ||
    result.meta.providerStarted === false ||
    result.meta.finalAssistantRawTextIsFallback === true
  ) {
    return undefined;
  }
  // finalAssistantVisibleText is never read: CLI settlement fills it with the
  // delivery mirror for tool-only turns.
  const rawText = result.meta.finalAssistantRawText;
  return typeof rawText === "string" && rawText.trim() ? rawText : undefined;
}
