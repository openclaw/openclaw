/**
 * Pure projection of Codex v2 thread items into local-session records. It must
 * stay deterministic: record seq is derived from position, so history and live
 * replay have to agree byte-for-byte across reconnects.
 */
import {
  clipLocalSessionRecordText,
  type LocalSessionRecord,
} from "openclaw/plugin-sdk/local-session-source";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThread, CodexThreadItem, CodexTurn } from "./app-server/protocol.js";

/** Record fields owned by the item itself; the session assigns seq and ts. */
export type CodexProjectedRecord = Omit<LocalSessionRecord, "seq" | "ts" | "turnId">;

/** Timestamped projection of one whole thread history, in chronological order. */
export type CodexHistoryRecord = Omit<LocalSessionRecord, "seq">;

const ARGS_PREVIEW_MAX_CHARS = 4_000;

function stringField(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === "string" ? value : undefined;
}

function boundedJson(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > ARGS_PREVIEW_MAX_CHARS ? `${text.slice(0, ARGS_PREVIEW_MAX_CHARS)}…` : text;
}

function textOfUserContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (isRecord(part) && part.type === "text" ? stringField(part, "text") : undefined))
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function textOfContentItems(contentItems: unknown): string {
  if (!Array.isArray(contentItems)) {
    return "";
  }
  return contentItems
    .map((part) =>
      isRecord(part) && part.type === "inputText" ? stringField(part, "text") : undefined,
    )
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function record(
  id: string,
  kind: LocalSessionRecord["kind"],
  rawText: string,
  extra: { toolName?: string; clientId?: string } = {},
): CodexProjectedRecord {
  const { text, truncated } = clipLocalSessionRecordText(rawText);
  return {
    id,
    kind,
    text,
    ...(extra.toolName ? { toolName: extra.toolName } : {}),
    ...(extra.clientId ? { clientId: extra.clientId } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

/**
 * Projects one item into zero, one, or two records. Tool items split into a
 * toolCall plus a toolResult (`<id>:result`) so a command that completes after
 * bootstrap still delivers its output as a new record.
 */
export function projectCodexThreadItem(item: CodexThreadItem): CodexProjectedRecord[] {
  const id = item.id;
  switch (item.type) {
    case "userMessage": {
      const text = textOfUserContent(item.content);
      return text ? [record(id, "user", text, { clientId: stringField(item, "clientId") })] : [];
    }
    case "agentMessage":
      return item.text ? [record(id, "assistant", item.text)] : [];
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const content = Array.isArray(item.content) ? item.content : [];
      const text = (summary.length > 0 ? summary : content)
        .filter((part): part is string => typeof part === "string")
        .join("\n");
      return text ? [record(id, "reasoning", text)] : [];
    }
    case "commandExecution": {
      const records = [record(id, "toolCall", item.command ?? "", { toolName: "shell" })];
      if (item.aggregatedOutput) {
        records.push(
          record(`${id}:result`, "toolResult", item.aggregatedOutput, { toolName: "shell" }),
        );
      }
      return records;
    }
    case "fileChange": {
      const summary = (Array.isArray(item.changes) ? item.changes : [])
        .map((change) => `${change.kind} ${change.path}`)
        .join("\n");
      return [record(id, "toolCall", summary, { toolName: "apply_patch" })];
    }
    case "mcpToolCall": {
      const toolName = `${item.server ?? "mcp"}/${item.tool ?? "tool"}`;
      const records = [record(id, "toolCall", boundedJson(item.arguments ?? {}), { toolName })];
      const outcome = item.error ?? item.result;
      if (outcome !== undefined && outcome !== null) {
        records.push(record(`${id}:result`, "toolResult", boundedJson(outcome), { toolName }));
      }
      return records;
    }
    case "dynamicToolCall": {
      const toolName = item.tool ?? "tool";
      const records = [record(id, "toolCall", boundedJson(item.arguments ?? {}), { toolName })];
      const output = textOfContentItems(item.contentItems);
      if (output) {
        records.push(record(`${id}:result`, "toolResult", output, { toolName }));
      }
      return records;
    }
    case "functionCallOutput": {
      const output = item.output;
      const text = typeof output === "string" ? output : boundedJson(output ?? "");
      return text ? [record(id, "toolResult", text, { toolName: item.name ?? undefined })] : [];
    }
    case "webSearch":
      return item.query ? [record(id, "toolCall", item.query, { toolName: "web_search" })] : [];
    default:
      return [];
  }
}

function isInProgress(item: CodexThreadItem): boolean {
  return item.status === "inProgress";
}

function turnTimestampMs(turn: CodexTurn, fallbackMs: number): number {
  const seconds = turn.completedAt ?? turn.startedAt;
  return typeof seconds === "number" && seconds > 0 ? Math.round(seconds * 1000) : fallbackMs;
}

/**
 * Flattens `thread.turns` chronologically. In-progress items are skipped: their
 * `item/completed` notification publishes the final record, so history and the
 * live stream never disagree about a tool's output.
 */
export function projectCodexThreadHistory(
  thread: CodexThread,
  nowMs: number,
): CodexHistoryRecord[] {
  const fallbackMs =
    typeof thread.updatedAt === "number" && thread.updatedAt > 0
      ? Math.round(thread.updatedAt * 1000)
      : nowMs;
  const records: CodexHistoryRecord[] = [];
  for (const turn of thread.turns ?? []) {
    const ts = turnTimestampMs(turn, fallbackMs);
    for (const item of turn.items) {
      if (isInProgress(item)) {
        continue;
      }
      for (const projected of projectCodexThreadItem(item)) {
        records.push({ ...projected, ts, turnId: turn.id });
      }
    }
  }
  return records;
}
