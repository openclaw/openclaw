const FENCED_TOOL_CALL_RE =
  /^\s*```(?:powershell|pwsh)\s*\r?\n\s*(?:powershell:\s*)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(([\s\S]*?)\)\s*\r?\n```\s*$/iu;

/**
 * Detects the complete-response shape emitted by local Ollama models when they
 * render a tool call as PowerShell instead of returning a structured call.
 *
 * This is intentionally diagnostic-only: callers must still refuse to execute
 * the fenced text. Requiring a single fenced response and an allowlisted tool
 * name avoids treating ordinary prose or examples as a provider failure.
 */
export function detectFencedOllamaToolCall(
  text: string,
  availableToolNames: ReadonlySet<string> | undefined,
): { name: string } | undefined {
  if (!availableToolNames || availableToolNames.size === 0) {
    return undefined;
  }
  const match = FENCED_TOOL_CALL_RE.exec(text);
  if (!match) {
    return undefined;
  }
  const name = match[1]?.trim();
  const argumentsText = match[2]?.trim();
  if (!name || !argumentsText || !availableToolNames.has(name)) {
    return undefined;
  }
  return { name };
}

export function formatFencedOllamaToolCallDiagnostic(name: string): string {
  return (
    `Ollama returned tool "${name}" as fenced PowerShell text instead of a structured tool call; ` +
    "no command was executed. Use a model with native Ollama tool-calling support or switch the model's tool template."
  );
}
