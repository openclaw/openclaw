import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

// Dangerous tools that must not be exposed to channel auto-reply by default.
// Prevents prompt-injection attacks from triggering RCE or credential theft.
const DEFAULT_DENIED_TOOLS: readonly string[] = [
  "edit",
  "edit_file",
  "exec",
  "multi_edit",
  "read",
  "read_file",
  "write",
  "write_file",
];

const TOOL_DENY_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  voice: ["tts"],
};

const TOOL_ALLOW_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  node: ["canvas", "image", "pdf", "tts", "web_fetch", "web_search"],
};

export function filterToolNamesByMessageProvider(
  toolNames: readonly string[],
  messageProvider?: string,
): string[] {
  const normalizedProvider = normalizeOptionalLowercaseString(messageProvider);
  if (!normalizedProvider) {
    return [...toolNames];
  }
  const allowedTools = TOOL_ALLOW_BY_MESSAGE_PROVIDER[normalizedProvider];
  if (allowedTools && allowedTools.length > 0) {
    const allowedSet = new Set(allowedTools);
    return toolNames.filter((toolName) => allowedSet.has(toolName));
  }
  // Merge provider-specific deny list (if any) with the default deny list.
  const providerDenied = TOOL_DENY_BY_MESSAGE_PROVIDER[normalizedProvider];
  const deniedTools = providerDenied
    ? [...DEFAULT_DENIED_TOOLS, ...providerDenied]
    : [...DEFAULT_DENIED_TOOLS];
  const deniedSet = new Set(deniedTools);
  return toolNames.filter((toolName) => !deniedSet.has(toolName));
}

export function filterToolsByMessageProvider<TTool extends { name: string }>(
  tools: readonly TTool[],
  messageProvider?: string,
): TTool[] {
  const filteredToolNames = filterToolNamesByMessageProvider(
    tools.map((tool) => tool.name),
    messageProvider,
  );
  const remainingCounts = new Map<string, number>();
  for (const toolName of filteredToolNames) {
    remainingCounts.set(toolName, (remainingCounts.get(toolName) ?? 0) + 1);
  }
  return tools.filter((tool) => {
    const remaining = remainingCounts.get(tool.name) ?? 0;
    if (remaining <= 0) {
      return false;
    }
    remainingCounts.set(tool.name, remaining - 1);
    return true;
  });
}
