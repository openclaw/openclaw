import type { CompletionWorkerOutput } from "./types.js";

export interface TranscriptRecord<T = unknown> {
  role: "assistant" | "tool" | "system" | "user";
  content?: string;
  toolName?: string;
  toolResult?: T;
  createdAt?: string;
}

export interface SessionsHistoryLikeMessage {
  role?: unknown;
  content?: unknown;
  toolName?: unknown;
  tool_name?: unknown;
  name?: unknown;
  toolResult?: unknown;
  tool_result?: unknown;
  result?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
}

const COMPLETION_TOOL_NAMES = new Set(["sessions_yield", "worker_completion"]);

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readRole(value: unknown): TranscriptRecord["role"] | undefined {
  return value === "assistant" || value === "tool" || value === "system" || value === "user"
    ? value
    : undefined;
}

function isCompletionWorkerOutput(value: unknown): value is CompletionWorkerOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.source === "string" && typeof record.status === "string";
}

export function normalizeSessionsHistoryMessages(
  messages: SessionsHistoryLikeMessage[],
): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const message of messages) {
    const role = readRole(message.role);
    if (role === undefined) {
      continue;
    }

    const record: TranscriptRecord = { role };
    const content = readOptionalString(message.content);
    const toolName = readOptionalString(message.toolName ?? message.tool_name ?? message.name);
    const createdAt = readOptionalString(message.createdAt ?? message.created_at);
    const toolResult = message.toolResult ?? message.tool_result ?? message.result;

    if (content !== undefined) {
      record.content = content;
    }
    if (toolName !== undefined) {
      record.toolName = toolName;
    }
    if (createdAt !== undefined) {
      record.createdAt = createdAt;
    }
    if (toolResult !== undefined) {
      record.toolResult = toolResult;
    }
    records.push(record);
  }
  return records;
}

export function selectTranscriptResult(
  records: TranscriptRecord[],
): CompletionWorkerOutput | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || record.role !== "tool" || !record.toolName) {
      continue;
    }
    if (!COMPLETION_TOOL_NAMES.has(record.toolName)) {
      continue;
    }
    if (isCompletionWorkerOutput(record.toolResult)) {
      return record.toolResult;
    }
    throw new Error(`Invalid transcript completion record for tool ${record.toolName}`);
  }
  return undefined;
}
