import type { CliBackendConfig } from "../config/types.js";
import { extractBalancedJsonFragments } from "../shared/balanced-json.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { isRecord } from "../utils.js";
import { sanitizeToolArgs } from "./pi-embedded-subscribe.tools.js";

type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type CliOutput = {
  text: string;
  rawText?: string;
  sessionId?: string;
  usage?: CliUsage;
  finalPromptText?: string;
};

export type CliStreamingDelta = {
  text: string;
  delta: string;
  sessionId?: string;
  usage?: CliUsage;
  /** Present when this delta carries a thinking chunk rather than assistant text. */
  thinkingDelta?: string;
  /** Accumulated thinking text so far; set whenever `thinkingDelta` is present. */
  thinkingText?: string;
  /**
   * When true, the emitter is signalling that `text` is a full replacement
   * — the live-chat merger should use `text` even when it is a strict
   * prefix of its previousText (which the default "rollback" branch would
   * otherwise treat as stale and ignore). Used by the rolling-timer
   * terminal-cleanup path where the new text is shorter than what's
   * already been shown.
   */
  replacement?: boolean;
};

function isClaudeCliProvider(providerId: string): boolean {
  return normalizeLowercaseStringOrEmpty(providerId) === "claude-cli";
}

function usesClaudeStreamJsonDialect(params: {
  backend: CliBackendConfig;
  providerId: string;
}): boolean {
  return (
    params.backend.jsonlDialect === "claude-stream-json" || isClaudeCliProvider(params.providerId)
  );
}

function isClaudeStreamJsonResult(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
}): boolean {
  return usesClaudeStreamJsonDialect(params) && params.parsed.type === "result";
}

function extractJsonObjectCandidates(raw: string): string[] {
  return extractBalancedJsonFragments(raw, { openers: ["{"] }).map((fragment) => fragment.json);
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

function readNestedErrorMessage(parsed: Record<string, unknown>): string | undefined {
  if (isRecord(parsed.error)) {
    const errorMessage = readNestedErrorMessage(parsed.error);
    if (errorMessage) {
      return errorMessage;
    }
  }
  if (typeof parsed.message === "string") {
    const trimmed = parsed.message.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof parsed.error === "string") {
    const trimmed = parsed.error.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function unwrapCliErrorText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  for (const parsed of parseJsonRecordCandidates(trimmed)) {
    const nested = readNestedErrorMessage(parsed);
    if (nested) {
      return nested;
    }
  }
  return trimmed;
}

function toCliUsage(raw: Record<string, unknown>): CliUsage | undefined {
  const readNestedCached = (key: "input_tokens_details" | "prompt_tokens_details") => {
    const nested = raw[key];
    if (!isRecord(nested)) {
      return undefined;
    }
    return typeof nested.cached_tokens === "number" && nested.cached_tokens > 0
      ? nested.cached_tokens
      : undefined;
  };
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
  const totalInput = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const nestedCached =
    readNestedCached("input_tokens_details") ?? readNestedCached("prompt_tokens_details");
  const cacheRead =
    pick("cache_read_input_tokens") ??
    pick("cached_input_tokens") ??
    pick("cacheRead") ??
    pick("cached") ??
    nestedCached;
  const input =
    pick("input") ??
    ((Object.hasOwn(raw, "cached") || nestedCached !== undefined) && typeof totalInput === "number"
      ? Math.max(0, totalInput - (cacheRead ?? 0))
      : totalInput);
  const cacheWrite =
    pick("cache_creation_input_tokens") ?? pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

function readCliUsage(parsed: Record<string, unknown>): CliUsage | undefined {
  if (isRecord(parsed.message) && isRecord(parsed.message.usage)) {
    const usage = toCliUsage(parsed.message.usage);
    if (usage) {
      return usage;
    }
  }
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

function unwrapNestedCliResultText(raw: string): string {
  let text = raw;
  for (let depth = 0; depth < 8; depth += 1) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) {
      return text;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (
        !isRecord(parsed) ||
        typeof parsed.type !== "string" ||
        parsed.type !== "result" ||
        typeof parsed.result !== "string"
      ) {
        return text;
      }
      text = parsed.result;
    } catch {
      return text;
    }
  }
  return text;
}

function collectExplicitCliErrorText(parsed: Record<string, unknown>): string {
  const nested = readNestedErrorMessage(parsed);
  if (nested) {
    return unwrapCliErrorText(nested);
  }

  if (parsed.is_error === true && typeof parsed.result === "string") {
    return unwrapCliErrorText(parsed.result);
  }

  if (parsed.type === "assistant") {
    const text = collectCliText(parsed.message);
    if (/^\s*API Error:/i.test(text)) {
      return unwrapCliErrorText(text);
    }
  }

  if (parsed.type === "error") {
    const text =
      collectCliText(parsed.message) ||
      collectCliText(parsed.content) ||
      collectCliText(parsed.result) ||
      collectCliText(parsed);
    return unwrapCliErrorText(text);
  }

  return "";
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

function shouldUnwrapNestedCliResultText(params: {
  providerId?: string;
  parsed: Record<string, unknown>;
}): boolean {
  if (!params.providerId || !isClaudeCliProvider(params.providerId)) {
    return false;
  }
  return !Object.hasOwn(params.parsed, "type") || params.parsed.type === "result";
}

export function parseCliJson(
  raw: string,
  backend: CliBackendConfig,
  providerId?: string,
): CliOutput | null {
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
    const trimmedText = (
      shouldUnwrapNestedCliResultText({ providerId, parsed })
        ? unwrapNestedCliResultText(nextText)
        : nextText
    ).trim();
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
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  sessionId?: string;
  usage?: CliUsage;
}): CliOutput | null {
  if (!usesClaudeStreamJsonDialect(params)) {
    return null;
  }
  if (
    typeof params.parsed.type === "string" &&
    params.parsed.type === "result" &&
    typeof params.parsed.result === "string"
  ) {
    const resultText = unwrapNestedCliResultText(params.parsed.result).trim();
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
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  textSoFar: string;
  sessionId?: string;
  usage?: CliUsage;
}): CliStreamingDelta | null {
  if (!usesClaudeStreamJsonDialect(params)) {
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

export type ClaudeToolEvent = {
  phase: "start";
  name: string;
  args: Record<string, unknown> | undefined;
  itemId: string | undefined;
  sessionId: string | undefined;
  usage: CliUsage | undefined;
};

type ClaudeToolBlockEntry = {
  id: string;
  name: string;
  input: unknown;
  partialJson: string;
  emitted: boolean;
};

function readClaudeToolBlockKey(
  event: Record<string, unknown>,
  block: Record<string, unknown>,
): string | undefined {
  const id = typeof block.id === "string" && block.id.trim() ? block.id.trim() : undefined;
  if (id) {
    return id;
  }
  const index =
    typeof event.index === "number"
      ? event.index
      : typeof event.content_block_index === "number"
        ? event.content_block_index
        : undefined;
  return index === undefined ? undefined : `index:${index}`;
}

function readClaudeToolName(block: Record<string, unknown>): string | undefined {
  for (const key of ["name", "tool_name", "toolName"] as const) {
    const value = block[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseClaudeToolArgs(
  input: unknown,
  partialJson: string,
): Record<string, unknown> | undefined {
  if (isRecord(input)) {
    return input;
  }
  const text =
    typeof input === "string" && input.trim()
      ? input.trim()
      : typeof partialJson === "string" && partialJson.trim()
        ? partialJson.trim()
        : "";
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readClaudeToolDeltaPartial(delta: unknown): string {
  if (!isRecord(delta)) {
    return "";
  }
  if (delta.type !== "input_json_delta") {
    return "";
  }
  return typeof delta.partial_json === "string" ? delta.partial_json : "";
}

function createClaudeToolUseTracker(params: {
  backend: CliBackendConfig;
  providerId: string;
  onToolEvent?: (evt: ClaudeToolEvent) => void;
  onToolText?: (text: string) => void;
  getSessionId: () => string | undefined;
  getUsage: () => CliUsage | undefined;
}): (parsed: Record<string, unknown>) => void {
  const toolBlocks = new Map<string, ClaudeToolBlockEntry>();

  const emitTool = (entry: ClaudeToolBlockEntry): void => {
    if (entry.emitted) {
      return;
    }
    if (!params.onToolEvent && !params.onToolText) {
      return;
    }
    let args = parseClaudeToolArgs(entry.input, entry.partialJson);
    if (args && Object.keys(args).length === 0 && entry.partialJson) {
      try {
        const p = JSON.parse(entry.partialJson);
        if (p && typeof p === "object") {
          args = p as Record<string, unknown>;
        }
      } catch {}
    }
    // Sanitize once before either consumer sees the args — matches the
    // existing embedded-runtime contract (pi-embedded-subscribe.handlers
    // .tools.ts) so tokens, API keys, and secret-bearing strings in
    // command / URL / header fields are redacted before they reach inline
    // assistant deltas OR structured tool events.
    const safeArgs = args ? (sanitizeToolArgs(args) as Record<string, unknown>) : undefined;
    if (params.onToolText) {
      let detail = "";
      if (safeArgs) {
        const val =
          safeArgs.command ||
          safeArgs.file_path ||
          safeArgs.pattern ||
          safeArgs.query ||
          safeArgs.description ||
          safeArgs.url;
        if (typeof val === "string" && val.trim()) {
          detail = val.trim();
          if (detail.length > 120) {
            detail = detail.slice(0, 117) + "…";
          }
        }
      }
      const ts = new Date().toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      params.onToolText(
        detail ? `\n\n[${ts}] 🛠️ ${entry.name}: ${detail}\n` : `\n\n[${ts}] 🛠️ ${entry.name}\n`,
      );
    }
    if (params.onToolEvent) {
      params.onToolEvent({
        phase: "start",
        name: entry.name,
        args: safeArgs,
        itemId: entry.id,
        sessionId: params.getSessionId(),
        usage: params.getUsage(),
      });
    }
    entry.emitted = true;
  };

  return (parsed) => {
    if (!usesClaudeStreamJsonDialect({ backend: params.backend, providerId: params.providerId })) {
      return;
    }
    if (parsed.type !== "stream_event" || !isRecord(parsed.event)) {
      return;
    }
    const event = parsed.event;
    if (event.type === "content_block_start" && isRecord(event.content_block)) {
      const block = event.content_block;
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        return;
      }
      const key = readClaudeToolBlockKey(event, block);
      const name = readClaudeToolName(block);
      if (!key || !name) {
        return;
      }
      const entry: ClaudeToolBlockEntry = {
        id: typeof block.id === "string" ? block.id : key,
        name,
        input: block.input,
        partialJson: "",
        emitted: false,
      };
      toolBlocks.set(key, entry);
      const idxKey =
        typeof event.index === "number"
          ? `index:${event.index}`
          : typeof event.content_block_index === "number"
            ? `index:${event.content_block_index}`
            : undefined;
      if (idxKey && idxKey !== key) {
        toolBlocks.set(idxKey, entry);
      }
      return;
    }
    if (event.type !== "content_block_delta" && event.type !== "content_block_stop") {
      return;
    }
    const index =
      typeof event.index === "number"
        ? event.index
        : typeof event.content_block_index === "number"
          ? event.content_block_index
          : undefined;
    if (index === undefined) {
      return;
    }
    const entry = toolBlocks.get(`index:${index}`) ?? Array.from(toolBlocks.values()).at(index);
    if (!entry) {
      return;
    }
    if (event.type === "content_block_delta") {
      const partial = readClaudeToolDeltaPartial(event.delta);
      if (partial) {
        entry.partialJson += partial;
      }
      return;
    }
    emitTool(entry);
    toolBlocks.delete(`index:${index}`);
    if (entry.id) {
      toolBlocks.delete(entry.id);
    }
  };
}

export function createCliJsonlStreamingParser(params: {
  backend: CliBackendConfig;
  providerId: string;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onToolEvent?: (evt: ClaudeToolEvent) => void;
  /**
   * Called at each tool-start emission to decide whether to also inject the
   * `\n\n[HH:MM:SS] 🛠️ ToolName: detail\n` marker (plus rolling 8s timer)
   * into the assistant text stream. Returning `false` keeps assistant text
   * clean — only the structured `onToolEvent` fires, which downstream channels
   * gate by their own tool-verbose policy. The callback is invoked per-tool
   * (not captured once at parser construction) so session-level verbose changes
   * mid-run are honoured: e.g. a user toggling tool verbose off during a long
   * run will stop subsequent inline markers immediately, matching the
   * server-chat re-resolution path. Omitting the callback defaults to `false`.
   */
  shouldInjectToolInlineMarkers?: () => boolean;
}) {
  let lineBuffer = "";
  let assistantText = "";
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  let output: CliOutput | null = null;
  const texts: string[] = [];

  // Rolling-timer state: while a tool runs, we paint `_ <elapsed>s — <hh:mm:ss>_`
  // at the tail of assistantText and refresh every 8s so the user sees the
  // turn is still alive. Cleared on next text_delta, on result, or on finish.
  let toolKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let toolKeepaliveStart = 0;
  let toolTickStart = -1;

  const clearToolKeepalive = (): void => {
    if (toolKeepaliveTimer) {
      clearInterval(toolKeepaliveTimer);
      toolKeepaliveTimer = null;
    }
  };

  const stripToolTick = (): void => {
    if (toolTickStart >= 0 && toolTickStart < assistantText.length) {
      assistantText = assistantText.slice(0, toolTickStart);
    }
    toolTickStart = -1;
  };

  // For terminal paths (result, finish) where no follow-up text delta is
  // coming: emit a replacement delta so the live-chat merger replaces the
  // stale `_ Ns ..._` tick that was last sent. The new `text` is a strict
  // prefix of the previously emitted text (timer suffix stripped) — the
  // merger's default rollback branch would keep the longer previousText,
  // leaving the timer visible. Set `replacement: true` to bypass that
  // branch and force the merger to honour the shorter text.
  const emitTickReplacementIfPainted = (): void => {
    if (toolTickStart < 0) {
      return;
    }
    stripToolTick();
    params.onAssistantDelta({ text: assistantText, delta: "", replacement: true });
  };

  const trackClaudeToolUse = createClaudeToolUseTracker({
    backend: params.backend,
    providerId: params.providerId,
    onToolEvent: params.onToolEvent,
    // Per-tool re-evaluation of inline-marker policy: invokes the caller's
    // resolver at emit time so a session verbose change mid-run is honoured.
    // No-op when the caller didn't pass a resolver (default: never inject).
    onToolText: (text) => {
      if (!params.shouldInjectToolInlineMarkers?.()) {
        return;
      }
      clearToolKeepalive();
      stripToolTick();
      assistantText += text;
      params.onAssistantDelta({ text: assistantText, delta: text });
      toolKeepaliveStart = Date.now();
      toolTickStart = assistantText.length;
      toolKeepaliveTimer = setInterval(() => {
        const elapsed = Math.round((Date.now() - toolKeepaliveStart) / 1000);
        const now = new Date().toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        assistantText = assistantText.slice(0, toolTickStart) + `_ ${elapsed}s — ${now}_`;
        // Replacement semantics for the tick: empty delta signals to the
        // live-chat merger to use the new full text rather than append a
        // delta to its previousText (which still contains the old tick).
        params.onAssistantDelta({ text: assistantText, delta: "" });
      }, 8000);
    },
    getSessionId: () => sessionId,
    getUsage: () => usage,
  });

  const handleParsedRecord = (parsed: Record<string, unknown>) => {
    sessionId = pickCliSessionId(parsed, params.backend) ?? sessionId;
    if (!sessionId && typeof parsed.thread_id === "string") {
      sessionId = parsed.thread_id.trim();
    }
    const nextUsage = readCliUsage(parsed);
    const shouldUseUsage =
      !isClaudeStreamJsonResult({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
      }) || !usage;
    if (shouldUseUsage) {
      usage = nextUsage ?? usage;
    }
    trackClaudeToolUse(parsed);

    const result = parseClaudeCliJsonlResult({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      sessionId,
      usage,
    });
    if (result) {
      clearToolKeepalive();
      emitTickReplacementIfPainted();
      output = result;
      return;
    }

    const item = isRecord(parsed.item) ? parsed.item : null;
    if (item && typeof item.text === "string") {
      const type = normalizeLowercaseStringOrEmpty(item.type);
      if (!type || type.includes("message")) {
        texts.push(item.text);
      }
    }

    let delta = parseClaudeCliStreamingDelta({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      textSoFar: assistantText,
      sessionId,
      usage,
    });
    if (!delta) {
      return;
    }
    if (toolKeepaliveTimer) {
      clearToolKeepalive();
      stripToolTick();
      if (!assistantText.endsWith("\n\n")) {
        assistantText = assistantText.replace(/\n*$/, "\n\n");
      }
      assistantText = assistantText + delta.delta;
      params.onAssistantDelta({
        text: assistantText,
        delta: "",
        sessionId: delta.sessionId,
        usage: delta.usage,
      });
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
      clearToolKeepalive();
      emitTickReplacementIfPainted();
      flushLines(true);
      // The final flush can parse a content_block_stop for a tool, which
      // (when inline markers are enabled) starts a fresh keepalive interval.
      // Re-clear after the flush so the parser is truly quiescent when
      // finish() returns — no setInterval left running past the caller's
      // "we're done" signal.
      clearToolKeepalive();
      emitTickReplacementIfPainted();
    },
    getOutput() {
      if (output) {
        return output;
      }
      const text = texts.join("\n").trim();
      return text ? { text, sessionId, usage } : null;
    },
  };
}

export function parseCliJsonl(
  raw: string,
  backend: CliBackendConfig,
  providerId: string,
): CliOutput | null {
  const lines = normalizeStringEntries(raw.split(/\r?\n/g));
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
      const nextUsage = readCliUsage(parsed);
      const shouldUseUsage = !isClaudeStreamJsonResult({ backend, providerId, parsed }) || !usage;
      if (shouldUseUsage) {
        usage = nextUsage ?? usage;
      }

      const claudeResult = parseClaudeCliJsonlResult({
        backend,
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
        const type = normalizeLowercaseStringOrEmpty(item.type);
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
  outputMode?: "json" | "jsonl" | "text";
  fallbackSessionId?: string;
}): CliOutput {
  const outputMode = params.outputMode ?? "text";
  if (outputMode === "text") {
    return { text: params.raw.trim(), sessionId: params.fallbackSessionId };
  }
  if (outputMode === "jsonl") {
    return (
      parseCliJsonl(params.raw, params.backend, params.providerId) ?? {
        text: params.raw.trim(),
        sessionId: params.fallbackSessionId,
      }
    );
  }
  return (
    parseCliJson(params.raw, params.backend, params.providerId) ?? {
      text: params.raw.trim(),
      sessionId: params.fallbackSessionId,
    }
  );
}

export function extractCliErrorMessage(raw: string): string | null {
  const parsedRecords = parseJsonRecordCandidates(raw);
  if (parsedRecords.length === 0) {
    return null;
  }

  let errorText = "";
  for (const parsed of parsedRecords) {
    const next = collectExplicitCliErrorText(parsed);
    if (next) {
      errorText = next;
    }
  }

  return errorText || null;
}
