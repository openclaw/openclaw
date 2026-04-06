import { isClaudeCliProvider } from "../../extensions/anthropic/api.js";
import type { CliBackendConfig } from "../config/types.js";
import { isRecord } from "../utils.js";

type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type CliOutput = {
  text: string;
  sessionId?: string;
  usage?: CliUsage;
};

export type CliStreamingDelta = {
  text: string;
  delta: string;
  sessionId?: string;
  usage?: CliUsage;
};

export type CliThinkingDelta = {
  text: string;
  delta: string;
  sessionId?: string;
  usage?: CliUsage;
};

export type CliToolUsePayload = {
  name: string;
  toolUseId?: string;
  input?: unknown;
};

export type CliToolResultPayload = {
  toolUseId?: string;
  text?: string;
  isError?: boolean;
  startLine?: number;
  numLines?: number;
  totalLines?: number;
};

function extractJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) {
        escaped = true;
      }
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function parseJsonRecordCandidates(raw: string): Record<string, unknown>[] {
  const parsedRecords: Record<string, unknown>[] = [];
  const trimmed = raw.trim();
  if (!trimmed) {
    return parsedRecords;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      parsedRecords.push(parsed);
      return parsedRecords;
    }
  } catch {
    // Fall back to scanning for top-level JSON objects embedded in mixed output.
  }

  for (const candidate of extractJsonObjectCandidates(trimmed)) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) {
        parsedRecords.push(parsed);
      }
    } catch {
      // Ignore malformed fragments and keep scanning remaining objects.
    }
  }

  return parsedRecords;
}

function toCliUsage(raw: Record<string, unknown>): CliUsage | undefined {
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
  const totalInput = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead =
    pick("cache_read_input_tokens") ??
    pick("cached_input_tokens") ??
    pick("cacheRead") ??
    pick("cached");
  const input =
    pick("input") ??
    (Object.hasOwn(raw, "cached") && typeof totalInput === "number"
      ? Math.max(0, totalInput - (cacheRead ?? 0))
      : totalInput);
  const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

function readCliUsage(parsed: Record<string, unknown>): CliUsage | undefined {
  if (isRecord(parsed.usage)) {
    const usage = toCliUsage(parsed.usage);
    if (usage) {
      return usage;
    }
  }
  if (isRecord(parsed.stats)) {
    return toCliUsage(parsed.stats);
  }
  return undefined;
}

function collectCliText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectCliText(entry)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.response === "string") {
    return value.response;
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.result === "string") {
    return value.result;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return value.content.map((entry) => collectCliText(entry)).join("");
  }
  if (isRecord(value.message)) {
    return collectCliText(value.message);
  }
  return "";
}

function collectToolResultText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectToolResultText(entry)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.result === "string") {
    return value.result;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return value.content.map((entry) => collectToolResultText(entry)).join("");
  }
  return collectCliText(value);
}

function pickCliSessionId(
  parsed: Record<string, unknown>,
  backend: CliBackendConfig,
): string | undefined {
  const fields = backend.sessionIdFields ?? [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ];
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function parseCliJson(raw: string, backend: CliBackendConfig): CliOutput | null {
  const parsedRecords = parseJsonRecordCandidates(raw);
  if (parsedRecords.length === 0) {
    return null;
  }

  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  let text = "";
  let sawStructuredOutput = false;
  for (const parsed of parsedRecords) {
    sessionId = pickCliSessionId(parsed, backend) ?? sessionId;
    usage = readCliUsage(parsed) ?? usage;
    const nextText =
      collectCliText(parsed.message) ||
      collectCliText(parsed.content) ||
      collectCliText(parsed.result) ||
      collectCliText(parsed.response) ||
      collectCliText(parsed);
    const trimmedText = nextText.trim();
    if (trimmedText) {
      text = trimmedText;
      sawStructuredOutput = true;
      continue;
    }
    if (sessionId || usage) {
      sawStructuredOutput = true;
    }
  }

  if (!text && !sawStructuredOutput) {
    return null;
  }
  return { text, sessionId, usage };
}

function parseClaudeCliJsonlResult(params: {
  providerId: string;
  parsed: Record<string, unknown>;
  sessionId?: string;
  usage?: CliUsage;
}): CliOutput | null {
  if (!isClaudeCliProvider(params.providerId)) {
    return null;
  }
  if (
    typeof params.parsed.type === "string" &&
    params.parsed.type === "result" &&
    typeof params.parsed.result === "string"
  ) {
    const resultText = params.parsed.result.trim();
    if (resultText) {
      return { text: resultText, sessionId: params.sessionId, usage: params.usage };
    }
    // Claude may finish with an empty result after tool-only work. Keep the
    // resolved session handle and usage instead of dropping them.
    return { text: "", sessionId: params.sessionId, usage: params.usage };
  }
  return null;
}

function parseClaudeCliStreamingDelta(params: {
  providerId: string;
  parsed: Record<string, unknown>;
  textSoFar: string;
  sessionId?: string;
  usage?: CliUsage;
}): CliStreamingDelta | null {
  if (!isClaudeCliProvider(params.providerId)) {
    return null;
  }
  if (params.parsed.type !== "stream_event" || !isRecord(params.parsed.event)) {
    return null;
  }
  const event = params.parsed.event;
  if (event.type !== "content_block_delta" || !isRecord(event.delta)) {
    return null;
  }
  const delta = event.delta;
  if (delta.type !== "text_delta" || typeof delta.text !== "string") {
    return null;
  }
  if (!delta.text) {
    return null;
  }
  return {
    text: `${params.textSoFar}${delta.text}`,
    delta: delta.text,
    sessionId: params.sessionId,
    usage: params.usage,
  };
}

function parseClaudeCliThinkingDelta(params: {
  providerId: string;
  parsed: Record<string, unknown>;
  textSoFar: string;
  sessionId?: string;
  usage?: CliUsage;
}): CliThinkingDelta | null {
  if (!isClaudeCliProvider(params.providerId)) {
    return null;
  }
  if (params.parsed.type !== "stream_event" || !isRecord(params.parsed.event)) {
    return null;
  }
  const event = params.parsed.event;
  if (event.type !== "content_block_delta" || !isRecord(event.delta)) {
    return null;
  }
  const delta = event.delta;
  if (delta.type !== "thinking_delta") {
    return null;
  }
  const deltaText =
    typeof delta.thinking === "string"
      ? delta.thinking
      : typeof delta.text === "string"
        ? delta.text
        : "";
  if (!deltaText) {
    return null;
  }
  return {
    text: `${params.textSoFar}${deltaText}`,
    delta: deltaText,
    sessionId: params.sessionId,
    usage: params.usage,
  };
}

export function createCliJsonlStreamingParser(params: {
  backend: CliBackendConfig;
  providerId: string;
  onSystemInit?: (payload: { subtype: string; sessionId?: string }) => void;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onToolUse?: (payload: CliToolUsePayload) => void;
  onToolResult?: (payload: CliToolResultPayload) => void;
}) {
  let lineBuffer = "";
  let assistantText = "";
  let thinkingText = "";
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  let sawThinkingStream = false;
  const seenRecordKeys = new Set<string>();
  const emittedToolUseKeys = new Set<string>();
  const emittedToolResultKeys = new Set<string>();

  const emitToolUseFromBlock = (block: Record<string, unknown>) => {
    if (!params.onToolUse) {
      return;
    }
    const emit = (payload: CliToolUsePayload) => {
      const key = `${payload.name}:${payload.toolUseId ?? "no-id"}:${JSON.stringify(payload.input ?? null)}`;
      if (emittedToolUseKeys.has(key)) {
        return;
      }
      emittedToolUseKeys.add(key);
      params.onToolUse?.(payload);
    };
    if (block.type === "tool_use" && typeof block.name === "string") {
      emit({
        name: block.name,
        toolUseId: typeof block.id === "string" ? block.id : undefined,
        input: block.input,
      });
      return;
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      emit({
        name: block.name,
        toolUseId: typeof block.id === "string" ? block.id : undefined,
        input: block.arguments,
      });
    }
  };

  const emitToolResultFromBlock = (block: Record<string, unknown>) => {
    if (!params.onToolResult || block.type !== "tool_result") {
      return;
    }
    const text = collectToolResultText(block.content).trim() || undefined;
    const isError = block.is_error === true;
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    const startLine =
      typeof block.startLine === "number" && Number.isFinite(block.startLine)
        ? Math.floor(block.startLine)
        : undefined;
    const numLines =
      typeof block.numLines === "number" && Number.isFinite(block.numLines)
        ? Math.floor(block.numLines)
        : undefined;
    const totalLines =
      typeof block.totalLines === "number" && Number.isFinite(block.totalLines)
        ? Math.floor(block.totalLines)
        : undefined;
    const key = `${toolUseId ?? "unknown"}:${isError ? "error" : "ok"}:${text ?? ""}:${startLine ?? ""}:${numLines ?? ""}:${totalLines ?? ""}`;
    if (emittedToolResultKeys.has(key)) {
      return;
    }
    emittedToolResultKeys.add(key);
    params.onToolResult({
      toolUseId,
      text,
      ...(isError ? { isError: true } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(numLines !== undefined ? { numLines } : {}),
      ...(totalLines !== undefined ? { totalLines } : {}),
    });
  };

  const emitThinkingFromBlock = (block: Record<string, unknown>) => {
    if (!params.onThinkingDelta || sawThinkingStream || block.type !== "thinking") {
      return;
    }
    const delta =
      typeof block.thinking === "string"
        ? block.thinking
        : typeof block.text === "string"
          ? block.text
          : "";
    if (!delta) {
      return;
    }
    thinkingText = `${thinkingText}${delta}`;
    params.onThinkingDelta({
      text: thinkingText,
      delta,
      sessionId,
      usage,
    });
  };

  const handleParsedRecord = (parsed: Record<string, unknown>) => {
    const recordKey = JSON.stringify(parsed);
    if (seenRecordKeys.has(recordKey)) {
      return;
    }
    seenRecordKeys.add(recordKey);
    sessionId = pickCliSessionId(parsed, params.backend) ?? sessionId;
    if (!sessionId && typeof parsed.thread_id === "string") {
      sessionId = parsed.thread_id.trim();
    }
    if (isRecord(parsed.usage)) {
      usage = toCliUsage(parsed.usage) ?? usage;
    }
    if (
      params.onSystemInit &&
      (parsed.type === "system" || parsed.type === "init") &&
      typeof parsed.subtype === "string"
    ) {
      params.onSystemInit({
        subtype: parsed.subtype,
        ...(sessionId ? { sessionId } : {}),
      });
    }

    // Detect tool_use events from content_block_start
    if (
      isClaudeCliProvider(params.providerId) &&
      (params.onToolUse || params.onToolResult || params.onThinkingDelta)
    ) {
      const event = isRecord(parsed.event) ? parsed.event : parsed;
      if (event.type === "content_block_start" && isRecord(event.content_block)) {
        emitToolUseFromBlock(event.content_block);
        emitToolResultFromBlock(event.content_block);
        emitThinkingFromBlock(event.content_block);
      }

      const message = isRecord(parsed.message) ? parsed.message : undefined;
      if (Array.isArray(message?.content)) {
        for (const entry of message.content) {
          if (isRecord(entry)) {
            emitToolUseFromBlock(entry);
            emitToolResultFromBlock(entry);
            emitThinkingFromBlock(entry);
          }
        }
      }

      if (Array.isArray(parsed.content)) {
        for (const entry of parsed.content) {
          if (isRecord(entry)) {
            emitToolUseFromBlock(entry);
            emitToolResultFromBlock(entry);
            emitThinkingFromBlock(entry);
          }
        }
      }
    }

    const thinkingDelta = parseClaudeCliThinkingDelta({
      providerId: params.providerId,
      parsed,
      textSoFar: thinkingText,
      sessionId,
      usage,
    });
    if (thinkingDelta) {
      sawThinkingStream = true;
      thinkingText = thinkingDelta.text;
      params.onThinkingDelta?.(thinkingDelta);
    }

    const delta = parseClaudeCliStreamingDelta({
      providerId: params.providerId,
      parsed,
      textSoFar: assistantText,
      sessionId,
      usage,
    });
    if (!delta) {
      return;
    }
    assistantText = delta.text;
    params.onAssistantDelta(delta);
  };

  const flushLines = (flushPartial: boolean) => {
    while (true) {
      const newlineIndex = lineBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      for (const parsed of parseJsonRecordCandidates(line)) {
        handleParsedRecord(parsed);
      }
    }
    if (!flushPartial) {
      return;
    }
    const tail = lineBuffer.trim();
    lineBuffer = "";
    if (!tail) {
      return;
    }
    for (const parsed of parseJsonRecordCandidates(tail)) {
      handleParsedRecord(parsed);
    }
  };

  return {
    push(chunk: string) {
      if (!chunk) {
        return;
      }
      lineBuffer += chunk;
      flushLines(false);
    },
    finish() {
      flushLines(true);
    },
  };
}

export function parseCliJsonl(
  raw: string,
  backend: CliBackendConfig,
  providerId: string,
): CliOutput | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  const texts: string[] = [];
  for (const line of lines) {
    for (const parsed of parseJsonRecordCandidates(line)) {
      if (!sessionId) {
        sessionId = pickCliSessionId(parsed, backend);
      }
      if (!sessionId && typeof parsed.thread_id === "string") {
        sessionId = parsed.thread_id.trim();
      }
      usage = readCliUsage(parsed) ?? usage;

      const claudeResult = parseClaudeCliJsonlResult({
        providerId,
        parsed,
        sessionId,
        usage,
      });
      if (claudeResult) {
        return claudeResult;
      }

      const item = isRecord(parsed.item) ? parsed.item : null;
      if (item && typeof item.text === "string") {
        const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
        if (!type || type.includes("message")) {
          texts.push(item.text);
        }
      }
    }
  }
  const text = texts.join("\n").trim();
  if (!text) {
    return null;
  }
  return { text, sessionId, usage };
}

export function parseCliOutput(params: {
  raw: string;
  backend: CliBackendConfig;
  providerId: string;
  outputMode?: "json" | "jsonl" | "stream-json" | "text";
  fallbackSessionId?: string;
}): CliOutput {
  const outputMode = params.outputMode ?? "text";
  if (outputMode === "text") {
    return { text: params.raw.trim(), sessionId: params.fallbackSessionId };
  }
  // stream-json output is line-delimited JSON; fall back to JSONL parsing for the raw output.
  if (outputMode === "jsonl" || outputMode === "stream-json") {
    return (
      parseCliJsonl(params.raw, params.backend, params.providerId) ?? {
        text: params.raw.trim(),
        sessionId: params.fallbackSessionId,
      }
    );
  }
  return (
    parseCliJson(params.raw, params.backend) ?? {
      text: params.raw.trim(),
      sessionId: params.fallbackSessionId,
    }
  );
}
