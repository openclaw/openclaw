import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionCatalogTranscriptItem } from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_TRANSCRIPT_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_TEXT_LENGTH = 1_000_000;

export type ClaudeTranscriptItem = {
  type: string;
  text?: string;
  content?: PluginJsonValue;
  timestamp?: string;
  model?: string;
  uuid?: string;
  resumeCursor?: string;
  truncated?: true;
};

function transcriptItemType(role: string, content: unknown): string {
  if (!Array.isArray(content)) {
    return role === "user" ? "userMessage" : "agentMessage";
  }
  const types = content.flatMap((block) =>
    isRecord(block) && typeof block.type === "string" ? [block.type] : [],
  );
  if (types.length > 0 && types.every((type) => type === "tool_result")) {
    return "toolResult";
  }
  if (types.length > 0 && types.every((type) => type === "tool_use")) {
    return "toolCall";
  }
  if (types.length > 0 && types.every((type) => type === "thinking")) {
    return "reasoning";
  }
  return role === "user" ? "userMessage" : "agentMessage";
}

export function collectTranscriptText(value: unknown, fragments: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) {
      fragments.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTranscriptText(item, fragments);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["text", "thinking", "content", "input"]) {
    if (key in value) {
      collectTranscriptText(value[key], fragments);
    }
  }
}

export function parseTranscriptLine(
  line: Buffer,
  optionalString: (value: unknown, maxLength: number) => string | undefined,
): ClaudeTranscriptItem | undefined {
  let raw: PluginJsonValue;
  try {
    // SAFETY: JSON.parse produces JSON values; the row and message shapes are checked below.
    raw = JSON.parse(line.toString("utf8")) as PluginJsonValue;
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.isSidechain === true || raw.isMeta === true || !isRecord(raw.message)) {
    return undefined;
  }
  const role = raw.message.role;
  if ((role !== "user" && role !== "assistant") || raw.type !== role) {
    return undefined;
  }
  const content = raw.message.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    return undefined;
  }
  const fragments: string[] = [];
  collectTranscriptText(content, fragments);
  const text = [...new Set(fragments)].join("\n\n");
  const itemType = transcriptItemType(role, content);
  const item: ClaudeTranscriptItem = {
    type: itemType,
    ...(text ? { text } : {}),
    content,
    ...(optionalString(raw.timestamp, 128)
      ? { timestamp: optionalString(raw.timestamp, 128) }
      : {}),
    ...(optionalString(raw.message.model, 256)
      ? { model: optionalString(raw.message.model, 256) }
      : {}),
    ...(optionalString(raw.uuid, 256) ? { uuid: optionalString(raw.uuid, 256) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(item), "utf8") <= MAX_TRANSCRIPT_ITEM_BYTES) {
    return item;
  }
  return {
    type: item.type,
    text: `${truncateUtf16Safe(text, MAX_TRANSCRIPT_TEXT_LENGTH)}\n\n[oversized Claude item truncated]`,
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.uuid ? { uuid: item.uuid } : {}),
    truncated: true,
  };
}

const CLAUDE_TRANSCRIPT_TYPES = new Map<string, SessionCatalogTranscriptItem["type"]>([
  ["userMessage", "userMessage"],
  ["agentMessage", "agentMessage"],
  ["reasoning", "reasoning"],
  ["toolCall", "toolCall"],
  ["toolResult", "toolResult"],
]);
const CLAUDE_BLOCK_TYPES = new Map<unknown, SessionCatalogTranscriptItem["type"]>([
  ["thinking", "reasoning"],
  ["tool_use", "toolCall"],
  ["tool_result", "toolResult"],
]);

export function toGenericClaudeItems(item: ClaudeTranscriptItem): SessionCatalogTranscriptItem[] {
  const common = {
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.truncated ? { truncated: true } : {}),
  };
  if (!Array.isArray(item.content)) {
    return [
      {
        ...common,
        ...(item.uuid ? { id: item.uuid } : {}),
        // Oversized rows lose their native blocks; their flattened text can contain
        // reasoning or tools, so consumers must not treat it as ordinary prose.
        type: item.truncated ? "other" : (CLAUDE_TRANSCRIPT_TYPES.get(item.type) ?? "other"),
        ...(item.text ? { text: item.text } : {}),
      },
    ];
  }
  // Mixed tools/reasoning must not inherit the row's user or assistant label.
  return item.content
    .flatMap((block, index): SessionCatalogTranscriptItem[] => {
      if (!isRecord(block)) {
        return [];
      }
      const messageType = item.type === "userMessage" ? "userMessage" : "agentMessage";
      const type =
        block.type === "text" ? messageType : (CLAUDE_BLOCK_TYPES.get(block.type) ?? "other");
      const fragments: string[] = [];
      if (block.type === "tool_use") {
        if (typeof block.name === "string") {
          fragments.push(block.name);
        }
        if (block.input !== undefined) {
          fragments.push(JSON.stringify(block.input));
        }
      } else {
        const content =
          block.type === "text" ? (typeof block.text === "string" ? block.text : "") : block;
        collectTranscriptText(content, fragments);
      }
      const text = fragments.join("\n\n");
      return [
        {
          ...common,
          ...(item.uuid ? { id: `${item.uuid}:${index}` } : {}),
          type,
          ...(block.type === "tool_use"
            ? {
                ...(typeof block.name === "string" ? { toolName: block.name } : {}),
                ...(typeof block.id === "string" ? { toolCallId: block.id } : {}),
                ...(block.input !== undefined ? { toolInput: block.input } : {}),
              }
            : block.type === "tool_result"
              ? {
                  toolName: "tool",
                  ...(typeof block.tool_use_id === "string"
                    ? { toolCallId: block.tool_use_id }
                    : {}),
                  isError: block.is_error === true,
                }
              : {}),
          ...(text ? { text } : {}),
        },
      ];
    })
    .toReversed();
}
