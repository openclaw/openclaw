import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { asPositiveFiniteNumber, resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { rethrowIncognitoSessionError } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptRawDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  asFiniteNumber,
  asOptionalRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  readExplicitMemoryEvidence,
  readStructuredMemoryEvidenceFromContent,
  readStructuredMemoryFailure,
  readStructuredMemoryFailureFromContent,
} from "./prompt.js";
import { extractTextContent } from "./query.js";
import {
  DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
  DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS,
  DEFAULT_TRANSCRIPT_READ_MAX_BYTES,
  DEFAULT_TRANSCRIPT_READ_MAX_LINES,
  LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  type ActiveMemorySearchDebug,
  type ActiveMemoryTranscriptSource,
  type TranscriptReadLimits,
} from "./types.js";

export function resolveTranscriptReadLimits(
  limits?: TranscriptReadLimits,
): Required<TranscriptReadLimits> {
  return {
    maxChars: resolveIntegerOption(limits?.maxChars, DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS, {
      min: 1,
      max: DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS,
    }),
    maxLines: resolveIntegerOption(limits?.maxLines, DEFAULT_TRANSCRIPT_READ_MAX_LINES, {
      min: 1,
      max: DEFAULT_TRANSCRIPT_READ_MAX_LINES,
    }),
    maxBytes: resolveIntegerOption(limits?.maxBytes, DEFAULT_TRANSCRIPT_READ_MAX_BYTES, {
      min: 1,
      max: DEFAULT_TRANSCRIPT_READ_MAX_BYTES,
    }),
  };
}

export async function streamActiveMemoryTranscriptRecords(params: {
  source: ActiveMemoryTranscriptSource;
  limits?: TranscriptReadLimits;
  onRecord: (record: unknown) => boolean | void;
}): Promise<void> {
  const limits = resolveTranscriptReadLimits(params.limits);
  let page: Awaited<ReturnType<typeof readSessionTranscriptRawDelta>>;
  try {
    page = await readSessionTranscriptRawDelta({
      ...params.source,
      maxBytes: limits.maxBytes,
      maxEvents: limits.maxLines,
    });
  } catch (error) {
    rethrowIncognitoSessionError(error);
    return;
  }
  if (page.kind !== "page") {
    return;
  }
  for (const { event } of page.events) {
    try {
      if (params.onRecord(event)) {
        break;
      }
    } catch {}
  }
}

function resolveToolResultMessage(value: unknown): Record<string, unknown> | undefined {
  const record = asOptionalRecord(value);
  const message =
    asOptionalRecord(record?.message) ?? (record?.role === "toolResult" ? record : undefined);
  return message && normalizeOptionalString(message.role) === "toolResult" ? message : undefined;
}

function extractActiveMemorySearchDebug(
  details: Record<string, unknown> | undefined,
): ActiveMemorySearchDebug | undefined {
  const debug = asOptionalRecord(details?.debug);
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
    searchMs: asFiniteNumber(debug?.searchMs),
    hits: asFiniteNumber(debug?.hits),
    warning,
    action,
    error,
  };
}

export function readMemoryResultFromSessionRecord(
  value: unknown,
  toolsAllow: readonly string[] = [
    ...DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
    ...LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  ],
) {
  const message = resolveToolResultMessage(value);
  const toolName = normalizeLowercaseStringOrEmpty(message?.toolName);
  const details = asOptionalRecord(message?.details);
  const isSearch = toolName === "memory_search" || toolName === "memory_recall";
  const searchDebug = isSearch ? extractActiveMemorySearchDebug(details) : undefined;
  const allowed = Boolean(toolName && toolsAllow.includes(toolName));
  const hasUnavailableMemorySearchResult =
    allowed &&
    (message?.isError === true ||
      readStructuredMemoryFailure(details) === true ||
      readStructuredMemoryFailureFromContent(message?.content) === true);
  const status = normalizeOptionalString(details?.status)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  const terminalUnavailable =
    allowed &&
    (details?.disabled === true ||
      details?.unavailable === true ||
      status === "disabled" ||
      status === "unavailable" ||
      (isSearch && (Boolean(searchDebug?.error) || Boolean(details?.error))));
  return {
    toolName,
    searchDebug,
    hasUnavailableMemorySearchResult,
    hasUsableMemoryResult:
      allowed &&
      !hasUnavailableMemorySearchResult &&
      hasUsableMemoryResult(toolName, details, message?.content),
    terminalUnavailable,
  };
}

type ActiveMemoryHookDeadline = {
  arm: (timeoutMs: number, onTimeout: () => void) => void;
  promise: Promise<symbol>;
  remainingMs: () => number;
  stop: () => void;
};

export function createActiveMemoryHookDeadline(): ActiveMemoryHookDeadline {
  const timeoutSentinel = Symbol("active-memory-hook-timeout");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let deadlineAt = 0;
  const { promise, resolve: resolveTimeout } = createDeferred<symbol>();
  const stop = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };
  const arm = (timeoutMs: number, onTimeout: () => void) => {
    stop();
    deadlineAt = performance.now() + timeoutMs;
    timeoutId = setTimeout(() => {
      onTimeout();
      resolveTimeout(timeoutSentinel);
    }, timeoutMs);
    timeoutId.unref?.();
  };
  // Remaining budget of the armed phase, so optional sub-steps can bound
  // themselves inside the same deadline instead of racing a fresh timer.
  const remainingMs = () =>
    timeoutId ? Math.max(0, Math.floor(deadlineAt - performance.now())) : 0;
  return { arm, promise, remainingMs, stop };
}

function hasExpandedSummary(details: Record<string, unknown> | undefined): boolean {
  return (
    asPositiveFiniteNumber(details?.expandedSummaryCount) !== undefined &&
    Boolean(normalizeOptionalString(details?.answer))
  );
}

function hasUsableMemoryResult(
  toolName: string,
  details: Record<string, unknown> | undefined,
  rawContent: unknown,
): boolean {
  const content = extractTextContent(rawContent);
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
    if (asPositiveFiniteNumber(details?.totalMatches) !== undefined) {
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
    return (
      hasExpandedSummary(details) || hasExpandedSummary(asOptionalRecord(safeParseJson(content)))
    );
  }
  const normalizedContent = normalizeOptionalString(content);
  const explicitEvidence = details ? readExplicitMemoryEvidence(details) : undefined;
  const structuredEvidence = normalizedContent
    ? readStructuredMemoryEvidenceFromContent(rawContent)
    : undefined;
  // Custom recall tools have a shipped native-output contract. Preserve
  // non-empty model-visible results unless structured fields explicitly say
  // the lookup was empty; explicit failures are rejected above.
  return Boolean(normalizedContent) && explicitEvidence !== false && structuredEvidence !== false;
}
