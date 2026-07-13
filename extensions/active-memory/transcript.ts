import fsSync from "node:fs";
import fs from "node:fs/promises";
import * as readline from "node:readline";
import { parseSqliteSessionFileMarker } from "openclaw/plugin-sdk/session-store-runtime";
import {
  readSessionTranscriptEvents,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  asOptionalRecord as asRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { clampInt } from "./config.js";
import {
  extractTextContent,
  normalizeActiveSummary,
  readExplicitMemoryEvidence,
  readStructuredMemoryEvidenceFromContent,
  readStructuredMemoryFailure,
  readStructuredMemoryFailureFromContent,
  truncateSummary,
} from "./prompt.js";
import {
  DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
  DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS,
  DEFAULT_TRANSCRIPT_READ_MAX_BYTES,
  DEFAULT_TRANSCRIPT_READ_MAX_LINES,
  LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  TERMINAL_MEMORY_SEARCH_POLL_INTERVAL_MS,
  TIMEOUT_PARTIAL_DATA_GRACE_MS,
  type ActiveMemoryPartialTimeoutError,
  type ActiveMemorySearchDebug,
  type ActiveMemoryTranscriptSource,
  type ActiveRecallResult,
  type RecallSubagentResult,
  type TerminalMemorySearchResult,
  type TerminalMemorySearchWatch,
  type TranscriptReadLimits,
} from "./types.js";

let timeoutPartialDataGraceMs = TIMEOUT_PARTIAL_DATA_GRACE_MS;

function isUnavailableMemorySearchDebug(debug?: ActiveMemorySearchDebug): boolean {
  return Boolean(debug?.error);
}
function resolveTranscriptReadLimits(
  limits?: TranscriptReadLimits,
): Required<TranscriptReadLimits> {
  return {
    maxChars: clampInt(
      limits?.maxChars,
      DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS,
      1,
      DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS,
    ),
    maxLines: clampInt(
      limits?.maxLines,
      DEFAULT_TRANSCRIPT_READ_MAX_LINES,
      1,
      DEFAULT_TRANSCRIPT_READ_MAX_LINES,
    ),
    maxBytes: clampInt(
      limits?.maxBytes,
      DEFAULT_TRANSCRIPT_READ_MAX_BYTES,
      1,
      DEFAULT_TRANSCRIPT_READ_MAX_BYTES,
    ),
  };
}

async function streamBoundedTranscriptJsonl(params: {
  sessionFile: string;
  limits?: TranscriptReadLimits;
  onRecord: (record: unknown) => boolean | void;
}): Promise<void> {
  const limits = resolveTranscriptReadLimits(params.limits);
  try {
    const stats = await fs.stat(params.sessionFile);
    if (!stats.isFile() || stats.size > limits.maxBytes) {
      return;
    }
  } catch {
    return;
  }
  const stream = fsSync.createReadStream(params.sessionFile, {
    encoding: "utf8",
  });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let seenLines = 0;
  try {
    for await (const line of rl) {
      seenLines += 1;
      if (seenLines > limits.maxLines) {
        break;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        if (params.onRecord(JSON.parse(trimmed) as unknown)) {
          break;
        }
      } catch {}
    }
  } catch {
    // Treat transcript recovery as best-effort on timeout/abort paths.
  } finally {
    rl.close();
    stream.destroy();
  }
}

function fileTranscriptSource(sessionFile: string): ActiveMemoryTranscriptSource {
  return { kind: "file", sessionFile };
}

function transcriptSourceFromReturnedSessionFile(params: {
  sessionFile: string;
  sessionKey: string;
}): ActiveMemoryTranscriptSource {
  const marker = parseSqliteSessionFileMarker(normalizeOptionalString(params.sessionFile));
  if (!marker) {
    return fileTranscriptSource(params.sessionFile);
  }
  return {
    kind: "runtime",
    target: {
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      sessionKey: params.sessionKey,
      storePath: marker.storePath,
    },
  };
}

function estimateTranscriptEventsBytes(events: readonly unknown[]): number {
  let total = 0;
  for (const event of events) {
    try {
      total += Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
    } catch {
      total += 1;
    }
  }
  return total;
}

async function streamRuntimeTranscriptEvents(params: {
  target: SessionTranscriptTargetParams;
  limits?: TranscriptReadLimits;
  onRecord: (record: unknown) => boolean | void;
}): Promise<void> {
  const limits = resolveTranscriptReadLimits(params.limits);
  let events: readonly unknown[];
  try {
    events = await readSessionTranscriptEvents(params.target);
  } catch {
    return;
  }
  if (estimateTranscriptEventsBytes(events) > limits.maxBytes) {
    return;
  }
  let seenLines = 0;
  for (const event of events) {
    seenLines += 1;
    if (seenLines > limits.maxLines) {
      break;
    }
    try {
      if (params.onRecord(event)) {
        break;
      }
    } catch {}
  }
}

async function streamActiveMemoryTranscriptRecords(params: {
  source: ActiveMemoryTranscriptSource;
  limits?: TranscriptReadLimits;
  onRecord: (record: unknown) => boolean | void;
}): Promise<void> {
  if (params.source.kind === "runtime") {
    await streamRuntimeTranscriptEvents({
      target: params.source.target,
      limits: params.limits,
      onRecord: params.onRecord,
    });
    return;
  }
  await streamBoundedTranscriptJsonl({
    sessionFile: params.source.sessionFile,
    limits: params.limits,
    onRecord: params.onRecord,
  });
}

function extractActiveMemorySearchDebugFromSessionRecord(
  value: unknown,
): ActiveMemorySearchDebug | undefined {
  const record = asRecord(value);
  const nestedMessage = asRecord(record?.message);
  const recordToolName = normalizeLowercaseStringOrEmpty(record?.toolName);
  const topLevelMessage =
    record?.role === "toolResult" ||
    recordToolName === "memory_search" ||
    recordToolName === "memory_recall"
      ? record
      : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message) {
    return undefined;
  }
  const role = normalizeOptionalString(message.role);
  const toolName = normalizeLowercaseStringOrEmpty(message.toolName);
  if (role !== "toolResult" || (toolName !== "memory_search" && toolName !== "memory_recall")) {
    return undefined;
  }
  const details = asRecord(message.details);
  const debug = asRecord(details?.debug);
  const warning = normalizeOptionalString(details?.warning);
  const action = normalizeOptionalString(details?.action);
  const error = normalizeOptionalString(details?.error);
  if (!debug && !warning && !action && !error) {
    return undefined;
  }
  return {
    backend: normalizeOptionalString(debug?.backend),
    configuredMode: normalizeOptionalString(debug?.configuredMode),
    effectiveMode: normalizeOptionalString(debug?.effectiveMode),
    fallback: normalizeOptionalString(debug?.fallback),
    searchMs:
      typeof debug?.searchMs === "number" && Number.isFinite(debug.searchMs)
        ? debug.searchMs
        : undefined,
    hits: typeof debug?.hits === "number" && Number.isFinite(debug.hits) ? debug.hits : undefined,
    warning,
    action,
    error,
  };
}

function extractToolResultNameFromSessionRecord(value: unknown): string | undefined {
  const record = asRecord(value);
  const nestedMessage = asRecord(record?.message);
  const topLevelMessage = record?.role === "toolResult" ? record : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message) {
    return undefined;
  }
  const role = normalizeOptionalString(message.role);
  const toolName = normalizeLowercaseStringOrEmpty(message.toolName);
  return role === "toolResult" && toolName ? toolName : undefined;
}

function hasUnavailableMemoryResultInSessionRecord(
  value: unknown,
  toolsAllow: readonly string[] = [
    ...DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
    ...LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  ],
): boolean {
  const record = asRecord(value);
  const nestedMessage = asRecord(record?.message);
  const topLevelMessage = record?.role === "toolResult" ? record : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message || normalizeOptionalString(message.role) !== "toolResult") {
    return false;
  }
  const toolName = normalizeLowercaseStringOrEmpty(message.toolName);
  if (!toolName || !toolsAllow.includes(toolName)) {
    return false;
  }
  const details = asRecord(message.details);
  const unavailable = message.isError === true || readStructuredMemoryFailure(details) === true;
  if (unavailable) {
    return true;
  }
  return readStructuredMemoryFailureFromContent(message.content) === true;
}

function hasTerminalUnavailableMemoryResultInSessionRecord(
  value: unknown,
  toolsAllow: readonly string[],
): boolean {
  const record = asRecord(value);
  const nestedMessage = asRecord(record?.message);
  const topLevelMessage = record?.role === "toolResult" ? record : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message || normalizeOptionalString(message.role) !== "toolResult") {
    return false;
  }
  const toolName = normalizeLowercaseStringOrEmpty(message.toolName);
  if (!toolName || !toolsAllow.includes(toolName)) {
    return false;
  }
  const details = asRecord(message.details);
  if (details?.disabled === true || details?.unavailable === true) {
    return true;
  }
  const status = normalizeOptionalString(details?.status)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (status === "disabled" || status === "unavailable") {
    return true;
  }
  if (toolName !== "memory_search" && toolName !== "memory_recall") {
    return false;
  }
  const debug = extractActiveMemorySearchDebugFromSessionRecord(value);
  return Boolean(debug?.error) || Boolean(details?.error);
}

type ActiveMemoryHookDeadline = {
  arm: (timeoutMs: number, onTimeout: () => void) => void;
  promise: Promise<symbol>;
  stop: () => void;
};

function createActiveMemoryHookDeadline(): ActiveMemoryHookDeadline {
  const timeoutSentinel = Symbol("active-memory-hook-timeout");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let resolveTimeout: (value: symbol) => void = () => {};
  const promise = new Promise<symbol>((resolve) => {
    resolveTimeout = resolve;
  });
  const stop = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };
  const arm = (timeoutMs: number, onTimeout: () => void) => {
    stop();
    timeoutId = setTimeout(() => {
      onTimeout();
      resolveTimeout(timeoutSentinel);
    }, timeoutMs);
    timeoutId.unref?.();
  };
  return { arm, promise, stop };
}

function hasUsableMemoryResultInSessionRecord(
  value: unknown,
  toolsAllow: readonly string[] = [
    ...DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
    ...LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  ],
): boolean {
  const record = asRecord(value);
  const nestedMessage = asRecord(record?.message);
  const recordToolName = normalizeLowercaseStringOrEmpty(record?.toolName);
  const topLevelMessage =
    record?.role === "toolResult" ||
    recordToolName === "memory_search" ||
    recordToolName === "memory_recall"
      ? record
      : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message || normalizeOptionalString(message.role) !== "toolResult") {
    return false;
  }
  const toolName = normalizeLowercaseStringOrEmpty(message.toolName);
  if (!toolName || !toolsAllow.includes(toolName)) {
    return false;
  }
  if (hasUnavailableMemoryResultInSessionRecord(value, toolsAllow)) {
    return false;
  }
  const details = asRecord(message.details);
  const content = extractTextContent(message.content);
  if (toolName === "memory_search") {
    if (Array.isArray(details?.results)) {
      return details.results.length > 0;
    }
    // Oversized details are capped before transcript persistence, while the
    // leading model-visible JSON still preserves whether results were present.
    return /"results"\s*:\s*\[\s*([^\s\]])/.test(content);
  }
  if (toolName === "memory_recall") {
    if (Array.isArray(details?.memories)) {
      return details.memories.length > 0;
    }
    return /^Found [1-9]\d* memories:/.test(content);
  }
  if (toolName === "memory_get") {
    const text = normalizeOptionalString(details?.text);
    return text !== undefined ? text.length > 0 : /"text"\s*:\s*"(?!")/.test(content);
  }
  if (toolName === "lcm_grep") {
    if (
      typeof details?.totalMatches === "number" &&
      Number.isFinite(details.totalMatches) &&
      details.totalMatches > 0
    ) {
      return true;
    }
    return /^## LCM Grep Results[\s\S]*^\*\*Total matches:\*\*\s+[1-9]\d*$/m.test(content);
  }
  if (toolName === "lcm_describe") {
    const type = normalizeOptionalString(details?.type);
    if (normalizeOptionalString(details?.id) && (type === "summary" || type === "file")) {
      return true;
    }
    return /^LCM_SUMMARY \S+/m.test(content) || /^## LCM File: \S+/m.test(content);
  }
  if (toolName === "lcm_expand_query") {
    if (
      typeof details?.expandedSummaryCount === "number" &&
      Number.isFinite(details.expandedSummaryCount) &&
      details.expandedSummaryCount > 0 &&
      Boolean(normalizeOptionalString(details?.answer))
    ) {
      return true;
    }
    try {
      const parsed = asRecord(JSON.parse(content));
      return (
        typeof parsed?.expandedSummaryCount === "number" &&
        Number.isFinite(parsed.expandedSummaryCount) &&
        parsed.expandedSummaryCount > 0 &&
        Boolean(normalizeOptionalString(parsed?.answer))
      );
    } catch {
      return false;
    }
  }
  const normalizedContent = normalizeOptionalString(content);
  const explicitEvidence = details ? readExplicitMemoryEvidence(details) : undefined;
  const structuredEvidence = normalizedContent
    ? readStructuredMemoryEvidenceFromContent(message.content)
    : undefined;
  // Custom recall tools have a shipped native-output contract. Preserve
  // non-empty model-visible results unless structured fields explicitly say
  // the lookup was empty; explicit failures are rejected above.
  return Boolean(normalizedContent) && explicitEvidence !== false && structuredEvidence !== false;
}

async function readActiveMemoryTranscriptState(
  source: ActiveMemoryTranscriptSource | string,
  limits?: TranscriptReadLimits,
  toolsAllow?: readonly string[],
): Promise<{
  searchDebug?: ActiveMemorySearchDebug;
  hasUsableMemoryResult: boolean;
  hasUnavailableMemorySearchResult: boolean;
}> {
  let searchDebug: ActiveMemorySearchDebug | undefined;
  let hasUsableMemoryResult = false;
  let hasUnavailableMemorySearchResult = false;
  await streamActiveMemoryTranscriptRecords({
    source: typeof source === "string" ? fileTranscriptSource(source) : source,
    limits,
    onRecord: (record) => {
      const debug = extractActiveMemorySearchDebugFromSessionRecord(record);
      if (debug) {
        searchDebug = debug;
      }
      hasUnavailableMemorySearchResult ||= hasUnavailableMemoryResultInSessionRecord(
        record,
        toolsAllow,
      );
      hasUsableMemoryResult ||= hasUsableMemoryResultInSessionRecord(record, toolsAllow);
    },
  });
  return { searchDebug, hasUsableMemoryResult, hasUnavailableMemorySearchResult };
}

async function readActiveMemorySearchDebug(
  source: ActiveMemoryTranscriptSource | string,
  limits?: TranscriptReadLimits,
): Promise<ActiveMemorySearchDebug | undefined> {
  return (await readActiveMemoryTranscriptState(source, limits)).searchDebug;
}

async function readMergedActiveMemoryTranscriptState(params: {
  sources: readonly ActiveMemoryTranscriptSource[];
  toolsAllow: readonly string[];
}): Promise<{
  searchDebug?: ActiveMemorySearchDebug;
  hasUsableMemoryResult: boolean;
  hasUnavailableMemorySearchResult: boolean;
}> {
  let searchDebug: ActiveMemorySearchDebug | undefined;
  let hasUsableMemoryResult = false;
  let hasUnavailableMemorySearchResult = false;
  const seen = new Set<string>();
  for (const source of params.sources) {
    const key =
      source.kind === "runtime"
        ? `runtime:${source.target.agentId ?? ""}:${source.target.sessionId}:${source.target.sessionKey}:${source.target.storePath ?? ""}:${source.target.threadId ?? ""}`
        : `file:${source.sessionFile}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const state = await readActiveMemoryTranscriptState(source, undefined, params.toolsAllow);
    searchDebug = state.searchDebug ?? searchDebug;
    hasUsableMemoryResult ||= state.hasUsableMemoryResult;
    hasUnavailableMemorySearchResult ||= state.hasUnavailableMemorySearchResult;
  }
  return { searchDebug, hasUsableMemoryResult, hasUnavailableMemorySearchResult };
}

async function readTerminalMemorySearchResult(
  source: ActiveMemoryTranscriptSource,
  limits?: TranscriptReadLimits,
  toolsAllow?: readonly string[],
): Promise<TerminalMemorySearchResult | undefined> {
  // memory_get consumes a path discovered by another tool; it is not an
  // independent fallback that should delay terminal unavailability.
  const recallPathNames = new Set(
    toolsAllow
      ?.map((toolName) => normalizeLowercaseStringOrEmpty(toolName))
      .filter((toolName) => toolName && toolName !== "memory_get"),
  );
  if (recallPathNames.size === 0) {
    return undefined;
  }
  const unavailablePathNames = new Set<string>();
  let hasUsableMemoryResult = false;
  let searchDebug: ActiveMemorySearchDebug | undefined;
  await streamActiveMemoryTranscriptRecords({
    source,
    limits,
    onRecord: (record) => {
      hasUsableMemoryResult ||= hasUsableMemoryResultInSessionRecord(record, toolsAllow);
      searchDebug = extractActiveMemorySearchDebugFromSessionRecord(record) ?? searchDebug;
      const toolName = extractToolResultNameFromSessionRecord(record);
      if (!toolName || !recallPathNames.has(toolName)) {
        return false;
      }
      if (hasTerminalUnavailableMemoryResultInSessionRecord(record, toolsAllow ?? [])) {
        unavailablePathNames.add(toolName);
      } else {
        unavailablePathNames.delete(toolName);
      }
      return false;
    },
  });
  if (unavailablePathNames.size !== recallPathNames.size) {
    return undefined;
  }
  return {
    status: "unavailable",
    hasUsableMemoryResult,
    searchDebug,
  };
}

async function readTerminalMemorySearchResultFromSources(
  sources: readonly ActiveMemoryTranscriptSource[],
  limits: TranscriptReadLimits | undefined,
  toolsAllow: readonly string[],
): Promise<TerminalMemorySearchResult | undefined> {
  for (const source of sources) {
    const result = await readTerminalMemorySearchResult(source, limits, toolsAllow);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function watchTerminalMemorySearchResult(params: {
  getTranscriptSources: () => readonly ActiveMemoryTranscriptSource[];
  abortSignal: AbortSignal;
  toolsAllow: readonly string[];
}): TerminalMemorySearchWatch {
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let resolveWatch: (result: TerminalMemorySearchResult) => void = () => {};
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    params.abortSignal.removeEventListener("abort", onAbort);
  };
  const finish = (result: TerminalMemorySearchResult) => {
    stop();
    resolveWatch(result);
  };
  const schedule = () => {
    if (stopped) {
      return;
    }
    timeoutId = setTimeout(() => {
      void tick();
    }, TERMINAL_MEMORY_SEARCH_POLL_INTERVAL_MS);
    timeoutId.unref?.();
  };
  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }
    if (params.abortSignal.aborted) {
      stop();
      return;
    }
    inFlight = true;
    try {
      const result = await readTerminalMemorySearchResultFromSources(
        params.getTranscriptSources(),
        undefined,
        params.toolsAllow,
      );
      if (result) {
        finish(result);
        return;
      }
    } catch {
      // Transcript polling is opportunistic; normal timeout handling remains authoritative.
    } finally {
      inFlight = false;
    }
    schedule();
  };
  function onAbort() {
    stop();
  }
  const promise = new Promise<TerminalMemorySearchResult>((resolve) => {
    resolveWatch = resolve;
    params.abortSignal.addEventListener("abort", onAbort, { once: true });
    void tick();
  });
  return {
    promise,
    stop,
  };
}

function normalizeSearchDebug(value: unknown): ActiveMemorySearchDebug | undefined {
  const debug = asRecord(value);
  if (!debug) {
    return undefined;
  }
  const normalized: ActiveMemorySearchDebug = {
    backend: normalizeOptionalString(debug.backend),
    configuredMode: normalizeOptionalString(debug.configuredMode),
    effectiveMode: normalizeOptionalString(debug.effectiveMode),
    fallback: normalizeOptionalString(debug.fallback),
    searchMs:
      typeof debug.searchMs === "number" && Number.isFinite(debug.searchMs)
        ? debug.searchMs
        : undefined,
    hits: typeof debug.hits === "number" && Number.isFinite(debug.hits) ? debug.hits : undefined,
    warning: normalizeOptionalString(debug.warning) ?? normalizeOptionalString(debug.reason),
    action: normalizeOptionalString(debug.action),
    error: normalizeOptionalString(debug.error),
  };
  return normalized.backend ||
    normalized.configuredMode ||
    normalized.effectiveMode ||
    normalized.fallback ||
    typeof normalized.searchMs === "number" ||
    typeof normalized.hits === "number" ||
    normalized.warning ||
    normalized.action ||
    normalized.error
    ? normalized
    : undefined;
}

function readActiveMemorySearchDebugFromRunResult(
  result: unknown,
): ActiveMemorySearchDebug | undefined {
  const record = asRecord(result);
  const meta = asRecord(record?.meta);
  return (
    normalizeSearchDebug(meta?.activeMemorySearchDebug) ??
    normalizeSearchDebug(meta?.memorySearchDebug) ??
    normalizeSearchDebug(record?.activeMemorySearchDebug) ??
    normalizeSearchDebug(record?.memorySearchDebug)
  );
}

function readActiveMemorySessionFileFromRunResult(result: unknown): string | undefined {
  const record = asRecord(result);
  const meta = asRecord(record?.meta);
  const agentMeta = asRecord(meta?.agentMeta);
  return (
    normalizeOptionalString(agentMeta?.sessionFile) ?? normalizeOptionalString(meta?.sessionFile)
  );
}

function readMemoryToolResultEvidence(params: {
  toolName: string;
  result: unknown;
  isError: boolean;
  toolsAllow: readonly string[];
}): {
  hasUsableMemoryResult: boolean;
  hasUnavailableMemorySearchResult: boolean;
} {
  const result = asRecord(params.result);
  const rawContent = result?.content;
  const textContent =
    normalizeOptionalString(result?.detailedContent) ??
    (typeof rawContent === "string" ? normalizeOptionalString(rawContent) : undefined);
  const record = {
    message: {
      role: "toolResult",
      toolName: params.toolName,
      isError: params.isError,
      content: Array.isArray(rawContent)
        ? rawContent
        : textContent
          ? [{ type: "text", text: textContent }]
          : [],
      details: result?.details,
    },
  };
  return {
    hasUsableMemoryResult: hasUsableMemoryResultInSessionRecord(record, params.toolsAllow),
    hasUnavailableMemorySearchResult: hasUnavailableMemoryResultInSessionRecord(
      record,
      params.toolsAllow,
    ),
  };
}

function extractAssistantTextFromSessionRecord(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const nestedMessage = asRecord(record.message);
  const topLevelMessage = normalizeOptionalString(record.role) === "assistant" ? record : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message || normalizeOptionalString(message.role) !== "assistant") {
    return "";
  }
  return extractTextContent(message.content).trim();
}

async function readPartialAssistantText(
  source: ActiveMemoryTranscriptSource | string | undefined,
  limits?: TranscriptReadLimits,
): Promise<string | null> {
  if (!source) {
    return null;
  }
  const texts: string[] = [];
  const resolvedLimits = resolveTranscriptReadLimits(limits);
  let collectedChars = 0;
  await streamActiveMemoryTranscriptRecords({
    source: typeof source === "string" ? fileTranscriptSource(source) : source,
    limits: resolvedLimits,
    onRecord: (record) => {
      const text = extractAssistantTextFromSessionRecord(record);
      if (text) {
        const separatorChars = texts.length > 0 ? 1 : 0;
        const remaining = resolvedLimits.maxChars - collectedChars - separatorChars;
        if (remaining <= 0) {
          return true;
        }
        const nextText = truncateUtf16Safe(text, remaining);
        if (!nextText) {
          return true;
        }
        texts.push(nextText);
        collectedChars += separatorChars + nextText.length;
        // A surrogate backoff leaves spare code units; stop instead of skipping ahead.
        return nextText.length < text.length || collectedChars >= resolvedLimits.maxChars;
      }
      return false;
    },
  });
  // Accepted chunks and separators are charged before append, so the join is already bounded.
  const joined = texts.join("\n").trim();
  return joined || null;
}

async function readPartialAssistantTextFromSources(
  sources: readonly ActiveMemoryTranscriptSource[],
  limits?: TranscriptReadLimits,
): Promise<string | null> {
  for (const source of sources) {
    const text = await readPartialAssistantText(source, limits);
    if (text) {
      return text;
    }
  }
  return null;
}

function attachPartialTimeoutData(
  error: unknown,
  partialReply: string | null,
  searchDebug: ActiveMemorySearchDebug | undefined,
  hasUnavailableMemorySearchResult: boolean,
): void {
  if (!error || typeof error !== "object") {
    return;
  }
  const target = error as ActiveMemoryPartialTimeoutError;
  if (partialReply) {
    target.activeMemoryPartialReply = partialReply;
  }
  if (searchDebug) {
    target.activeMemorySearchDebug = searchDebug;
  }
  if (hasUnavailableMemorySearchResult) {
    target.activeMemoryUnavailableMemorySearch = true;
  }
}

function readPartialTimeoutData(error: unknown): {
  rawReply?: string;
  searchDebug?: ActiveMemorySearchDebug;
  hasUnavailableMemorySearchResult?: boolean;
} {
  if (!error || typeof error !== "object") {
    return {};
  }
  const source = error as ActiveMemoryPartialTimeoutError;
  return {
    rawReply: normalizeOptionalString(source.activeMemoryPartialReply),
    searchDebug: source.activeMemorySearchDebug,
    hasUnavailableMemorySearchResult: source.activeMemoryUnavailableMemorySearch,
  };
}

async function waitForSubagentPartialTimeoutData(
  subagentPromise: Promise<RecallSubagentResult> | undefined,
): Promise<{
  rawReply?: string;
  searchDebug?: ActiveMemorySearchDebug;
  hasUnavailableMemorySearchResult?: boolean;
  settled: boolean;
}> {
  if (!subagentPromise) {
    return { settled: true };
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ settled: false }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ settled: false }), timeoutPartialDataGraceMs);
    timeoutId.unref?.();
  });
  try {
    return await Promise.race([
      subagentPromise.then(
        () => ({ settled: true as const }),
        (error: unknown) => ({ ...readPartialTimeoutData(error), settled: true as const }),
      ),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function buildTimeoutRecallResult(params: {
  elapsedMs: number;
  maxSummaryChars: number;
  transcriptSources: readonly ActiveMemoryTranscriptSource[];
  rawReply?: string;
  searchDebug?: ActiveMemorySearchDebug;
  hasUnavailableMemorySearchResult?: boolean;
  subagentPromise?: Promise<RecallSubagentResult>;
  toolsAllow: readonly string[];
}): Promise<ActiveRecallResult> {
  const subagentPartialData = params.rawReply
    ? { settled: true as const }
    : await waitForSubagentPartialTimeoutData(params.subagentPromise);
  const rawReply =
    params.rawReply ??
    subagentPartialData.rawReply ??
    (await readPartialAssistantTextFromSources(params.transcriptSources));
  const summary = truncateSummary(
    normalizeActiveSummary(rawReply ?? "") ?? "",
    params.maxSummaryChars,
  );
  const transcriptState =
    params.transcriptSources.length > 0
      ? await readMergedActiveMemoryTranscriptState({
          sources: params.transcriptSources,
          toolsAllow: params.toolsAllow,
        })
      : undefined;
  const searchDebug =
    params.searchDebug ?? subagentPartialData.searchDebug ?? transcriptState?.searchDebug;
  if (
    summary.length === 0 ||
    isUnavailableMemorySearchDebug(searchDebug) ||
    !subagentPartialData.settled ||
    params.hasUnavailableMemorySearchResult ||
    subagentPartialData.hasUnavailableMemorySearchResult ||
    transcriptState?.hasUnavailableMemorySearchResult
  ) {
    return {
      status: "timeout",
      elapsedMs: params.elapsedMs,
      summary: null,
      searchDebug,
    };
  }
  return {
    status: "timeout_partial",
    elapsedMs: params.elapsedMs,
    summary,
    searchDebug,
  };
}

function buildSubagentRecallResult(params: {
  subagentResult: RecallSubagentResult;
  fallbackSearchDebug?: ActiveMemorySearchDebug;
  fallbackHasUsableMemoryResult?: boolean;
  elapsedMs: number;
  maxSummaryChars: number;
}): ActiveRecallResult {
  const { rawReply, resultStatus } = params.subagentResult;
  const searchDebug = params.subagentResult.searchDebug ?? params.fallbackSearchDebug;
  const summary = truncateSummary(normalizeActiveSummary(rawReply) ?? "", params.maxSummaryChars);
  const hasUsableMemoryResult =
    params.subagentResult.hasUsableMemoryResult === true ||
    params.fallbackHasUsableMemoryResult === true;
  const hasUnavailableMemorySearchResult =
    params.subagentResult.hasUnavailableMemorySearchResult === true;
  const canUseSummary = hasUsableMemoryResult;
  return summary.length > 0 && canUseSummary
    ? {
        status: "ok",
        elapsedMs: params.elapsedMs,
        rawReply,
        summary,
        searchDebug,
      }
    : resultStatus === "failed"
      ? {
          status: "failed",
          elapsedMs: params.elapsedMs,
          summary: null,
          searchDebug,
        }
      : resultStatus === "unavailable" ||
          isUnavailableMemorySearchDebug(searchDebug) ||
          hasUnavailableMemorySearchResult
        ? {
            status: "unavailable",
            elapsedMs: params.elapsedMs,
            summary: null,
            searchDebug,
          }
        : {
            status: "no_relevant_memory",
            elapsedMs: params.elapsedMs,
            summary: null,
            searchDebug,
          };
}

function resetActiveMemoryTranscriptForTests(): void {
  timeoutPartialDataGraceMs = TIMEOUT_PARTIAL_DATA_GRACE_MS;
}

function setTimeoutPartialDataGraceMsForTests(value: number): void {
  timeoutPartialDataGraceMs = Math.max(0, Math.floor(value));
}

export {
  attachPartialTimeoutData,
  buildSubagentRecallResult,
  buildTimeoutRecallResult,
  createActiveMemoryHookDeadline,
  fileTranscriptSource,
  hasUsableMemoryResultInSessionRecord,
  isUnavailableMemorySearchDebug,
  readActiveMemorySearchDebug,
  readActiveMemorySearchDebugFromRunResult,
  readActiveMemorySessionFileFromRunResult,
  readMergedActiveMemoryTranscriptState,
  readMemoryToolResultEvidence,
  readPartialAssistantText,
  readPartialAssistantTextFromSources,
  readPartialTimeoutData,
  resetActiveMemoryTranscriptForTests,
  setTimeoutPartialDataGraceMsForTests,
  transcriptSourceFromReturnedSessionFile,
  watchTerminalMemorySearchResult,
};
