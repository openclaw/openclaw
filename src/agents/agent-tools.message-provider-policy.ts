/**
 * Message-provider tool filtering.
 * Channels can restrict tool names after runtime assembly when the active
 * transport cannot safely render or execute a class of tools.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const TOOL_DENY_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  "discord-voice": ["tts"],
  voice: ["tts"],
};

const TOOL_ALLOW_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  node: ["canvas", "image", "pdf", "tts", "web_fetch", "web_search"],
};

type ReadableToolName<TTool> = {
  readonly name: string;
  readonly tool: TTool;
};

function readToolName(tool: { name: string }): string | undefined {
  try {
    return tool.name;
  } catch {
    return undefined;
  }
}

/** Filters tool names by the active message-provider allow/deny policy. */
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
  const deniedTools = TOOL_DENY_BY_MESSAGE_PROVIDER[normalizedProvider];
  if (!deniedTools || deniedTools.length === 0) {
    return [...toolNames];
  }
  const deniedSet = new Set(deniedTools);
  return toolNames.filter((toolName) => !deniedSet.has(toolName));
}

/** Applies message-provider filtering while preserving duplicate tool entries. */
export function filterToolsByMessageProvider<TTool extends { name: string }>(
  tools: readonly TTool[],
  messageProvider?: string,
): TTool[] {
  const normalizedProvider = normalizeOptionalLowercaseString(messageProvider);
  if (!normalizedProvider) {
    return [...tools];
  }
  const allowedTools = TOOL_ALLOW_BY_MESSAGE_PROVIDER[normalizedProvider];
  const deniedTools = TOOL_DENY_BY_MESSAGE_PROVIDER[normalizedProvider];
  if ((!allowedTools || allowedTools.length === 0) && (!deniedTools || deniedTools.length === 0)) {
    return [...tools];
  }
  const readableTools: ReadableToolName<TTool>[] = [];
  for (const tool of tools) {
    const name = readToolName(tool);
    if (name) {
      readableTools.push({ name, tool });
    }
  }
  const filteredToolNames = filterToolNamesByMessageProvider(
    readableTools.map((tool) => tool.name),
    normalizedProvider,
  );
  const remainingCounts = new Map<string, number>();
  for (const toolName of filteredToolNames) {
    remainingCounts.set(toolName, (remainingCounts.get(toolName) ?? 0) + 1);
  }
  return readableTools.flatMap(({ name, tool }) => {
    const remaining = remainingCounts.get(name) ?? 0;
    if (remaining <= 0) {
      return [];
    }
    remainingCounts.set(name, remaining - 1);
    return [tool];
  });
}
