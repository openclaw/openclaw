import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { createEmptyTransportUsage } from "openclaw/plugin-sdk/provider-stream-shared";
import { withSessionTranscriptWrite } from "openclaw/plugin-sdk/session-transcript-runtime";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";
import type { ClaudeTranscriptItem } from "./session-catalog-transcript.js";

function importedClaudeMessage(
  item: ClaudeTranscriptItem,
  fallbackTimestamp: number,
): AgentMessage | undefined {
  const timestamp = parseDateStringTimestampMs(item.timestamp) ?? fallbackTimestamp;
  const importedText = item.text?.trim();
  if (!importedText && item.type === "reasoning") {
    return undefined;
  }
  const text = importedText || "[Unsupported Claude transcript item]";
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
  const prefix =
    item.type === "reasoning"
      ? "Thinking\n\n"
      : item.type === "toolCall"
        ? "Tool call\n\n"
        : item.type === "toolResult"
          ? "Tool result\n\n"
          : "";
  return {
    role: "assistant",
    content: [{ type: "text", text: `${prefix}${text}` }],
    timestamp,
    api: "anthropic-messages",
    provider: CLAUDE_CLI_BACKEND_ID,
    model: "native-history",
    usage: createEmptyTransportUsage(),
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
  // A retained-window position is not durable identity: growth between import
  // attempts shifts the window, so one index maps to different messages across
  // recovery, and the conflicting-key rejection permanently blocks adoption.
  const missingUuid = items.findIndex((item) => !item.uuid);
  if (missingUuid !== -1) {
    // params.items is newest-first; report the caller-facing row position.
    const callerRow = items.length - 1 - missingUuid;
    throw new Error(
      `claude transcript row ${callerRow}/${items.length} has no stable import uuid for ${params.threadId}; the transcript reader must supply source-coordinate uuids`,
    );
  }
  await withSessionTranscriptWrite(params, async (transcript) => {
    for (const [index, item] of items.entries()) {
      const imported = importedClaudeMessage(item, Date.now() + index);
      if (!imported) {
        continue;
      }
      // The idempotency key rides on the message so recovery re-imports dedupe.
      const message: AgentMessage & { idempotencyKey: string } = {
        ...imported,
        idempotencyKey: `claude-catalog:${params.threadId}:${item.uuid}`,
      };
      await transcript.appendMessage({
        message,
        idempotencyLookup: "scan",
        cwd: params.cwd,
      });
    }
  });
}
