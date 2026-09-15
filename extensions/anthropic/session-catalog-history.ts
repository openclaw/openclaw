import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import type { SessionCatalogTranscriptItem } from "openclaw/plugin-sdk/session-catalog";
import { withSessionTranscriptWriteLock } from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";
import { toGenericClaudeItems, type ClaudeTranscriptItem } from "./session-catalog-transcript.js";

function importedClaudeMessage(
  item: SessionCatalogTranscriptItem,
  fallbackTimestamp: number,
): AgentMessage | undefined {
  const timestamp = parseDateStringTimestampMs(item.timestamp) ?? fallbackTimestamp;
  const importedText = item.text?.trim();
  if (!importedText && item.type === "reasoning") {
    return undefined;
  }
  const toolInput = isRecord(item.toolInput) ? item.toolInput : undefined;
  const nonObjectInput = item.toolInput !== undefined && !toolInput;
  const text =
    item.type === "toolCall" && nonObjectInput
      ? `${item.toolName ?? "tool"}\n\n${JSON.stringify(item.toolInput, null, 2)}`
      : importedText || "[Unsupported Claude transcript item]";
  if (item.type === "userMessage") {
    // Imported native rows are not OpenClaw-authored; mirrorOrigin excludes them
    // from self-echo provenance so a repeated native prompt stays observable.
    return {
      role: "user",
      content: text,
      timestamp,
      __openclaw: { mirrorOrigin: "claude-catalog-import" },
    } as AgentMessage;
  }
  if (item.type === "toolResult" && item.toolCallId) {
    return {
      role: "toolResult",
      toolCallId: item.toolCallId,
      toolName: item.toolName ?? "tool",
      content: [{ type: "text", text: item.text ?? "" }],
      isError: item.isError === true,
      timestamp,
    };
  }
  const prefix =
    item.type === "toolCall" && (!item.toolName || nonObjectInput)
      ? "Tool call\n\n"
      : item.type === "toolResult"
        ? "Tool result\n\n"
        : "";
  const content =
    item.type === "reasoning"
      ? [{ type: "thinking" as const, thinking: text }]
      : item.type === "toolCall" && item.toolName && !nonObjectInput
        ? [
            {
              type: "toolCall" as const,
              id: item.toolCallId ?? `claude:${item.id ?? timestamp}`,
              name: item.toolName,
              arguments: toolInput ?? {},
            },
          ]
        : [{ type: "text" as const, text: `${prefix}${text}` }];
  return {
    role: "assistant",
    content,
    timestamp,
    api: "anthropic-messages",
    provider: CLAUDE_CLI_BACKEND_ID,
    model: "native-history",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  } as AgentMessage;
}

export async function importClaudeHistory(params: {
  items: ClaudeTranscriptItem[];
  threadId: string;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  storePath: string;
  cwd?: string;
  config: OpenClawConfig;
}): Promise<void> {
  const items = params.items.toReversed();
  await withSessionTranscriptWriteLock(params, async (transcript) => {
    for (const [index, item] of items.entries()) {
      const blocks = toGenericClaudeItems(item).toReversed();
      for (const [blockIndex, block] of blocks.entries()) {
        const imported = importedClaudeMessage(block, Date.now() + index);
        if (!imported) {
          continue;
        }
        // Preserve the row recovery key for its first block; additional blocks
        // have independent keys so interrupted imports can resume safely.
        const idempotencyKey =
          blockIndex === 0
            ? `claude-catalog:${params.threadId}:${item.uuid ?? index}`
            : `claude-catalog-block:${params.threadId}:${block.id ?? `${index}:${blockIndex}`}`;
        await transcript.appendMessage({
          message: { ...imported, idempotencyKey },
          idempotencyLookup: "scan",
          cwd: params.cwd,
        });
      }
    }
  });
}
