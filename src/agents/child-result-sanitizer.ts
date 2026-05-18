import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const CHILD_RESULT_SANITIZED_PLACEHOLDER_PREFIX = "[OpenClaw sanitized child result:";

const CHILD_RESULT_SANITIZED_PLACEHOLDER_RE = /\[OpenClaw sanitized child result:[^\]]*\]/;
const LEGACY_UNTRUSTED_RESULT_BEGIN = "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>";
const LEGACY_UNTRUSTED_RESULT_END = "<<<END_UNTRUSTED_CHILD_RESULT>>>";
const FLEX_BEGIN_RE =
  /(?:<\s*<\s*<\s*)?(?:\\n|\\r|\\t|\s)*BEGIN(?:\\n|\\r|\\t|\s|_|-)*UNTRUSTED(?:\\n|\\r|\\t|\s|_|-)*CHILD(?:\\n|\\r|\\t|\s|_|-)*RESULT(?:\\n|\\r|\\t|\s)*(?:>\s*>\s*>)?/gi;
const FLEX_END_RE =
  /(?:<\s*<\s*<\s*)?(?:\\n|\\r|\\t|\s)*END(?:\\n|\\r|\\t|\s|_|-)*UNTRUSTED(?:\\n|\\r|\\t|\s|_|-)*CHILD(?:\\n|\\r|\\t|\s|_|-)*RESULT(?:\\n|\\r|\\t|\s)*(?:>\s*>\s*>)?/gi;
const SOURCE_LIKE_RE =
  /(^|\n)\s*(?:diff --git|@@\s|---\s|\+\+\+\s|Index:\s|import\s+[^\n]+\s+from\s+|export\s+(?:async\s+)?(?:function|const|class|type|interface)\b|(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|class\s+[A-Za-z_$][\w$]*\b)/m;
const LOG_LIKE_RE =
  /(^|\n)\s*(?:\[?\d{4}-\d{2}-\d{2}[T\s]|Traceback \(most recent call last\)|Error:\s|Command exited with code|npm ERR!|pnpm\s+(?:ERR|WARN)|at\s+[A-Za-z0-9_.$<>]+\s*\(|\[\.\.\.\s*\d+\s+more\s+(?:lines|characters)\b)/m;
const PROMPT_INJECTION_RE =
  /\b(?:ignore (?:all )?(?:previous|above) instructions|do not (?:summarize|sanitize|redact)|preserve (?:this|the) (?:text|body|payload) verbatim|repeat (?:this|the) (?:text|body|payload) verbatim|print (?:the )?raw|include (?:the )?full (?:body|payload|log|source))\b/i;
const CHILD_CONTEXT_RE =
  /\b(?:subagent|sub-agent|child\s+(?:agent|result|completion|output|body|payload)|untrusted\s+child|quarantin(?:e|ed)|artifact\s+id|childResult|BEGIN_UNTRUSTED_CHILD_RESULT|END_UNTRUSTED_CHILD_RESULT)\b/i;
const STATE_RE =
  /\b(PASS|PASSED|FAIL|FAILED|REVISE|BLOCKED_INFRA|BLOCKED|ERROR|ACCEPT|REJECTED|TIMEOUT|CANCELLED|CANCELED)\b/i;
const NULL_BYTE = String.fromCharCode(0);

function hasNonTextCodePoint(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    const allowedControl = codePoint === 9 || codePoint === 10 || codePoint === 13;
    const allowedText =
      (codePoint >= 0x20 && codePoint <= 0xd7ff) || (codePoint >= 0xe000 && codePoint <= 0xfffd);
    if (!allowedControl && !allowedText) {
      return true;
    }
  }
  return false;
}

export type ChildResultSanitizerOptions = {
  surface?: string;
  taskLabel?: string;
  normalizedState?: string;
  reason?: string;
  artifactId?: string;
  unsafeHint?: boolean;
  maxSummaryChars?: number;
};

export type SanitizedChildResult = {
  sanitizedText: string;
  changed: boolean;
  replacementCount: number;
  classifications: string[];
  byteCount: number;
  sha256: string;
  summary: string;
};

type SegmentReplacement = {
  raw: string;
  classifications: string[];
  surface?: string;
  taskLabel?: string;
  normalizedState?: string;
  reason?: string;
  artifactId?: string;
  maxSummaryChars?: number;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function normalizeState(value?: string): string {
  const raw = value?.trim() || "";
  const match = raw.match(STATE_RE);
  const state = (match?.[1] ?? raw).toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  if (state === "passed") {
    return "pass";
  }
  if (state === "failed" || state === "fail") {
    return "failed";
  }
  if (state === "canceled") {
    return "cancelled";
  }
  if (state === "") {
    return "unknown";
  }
  return state.slice(0, 32);
}

function normalizeToken(value: string | undefined, fallback: string, maxChars = 80): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const normalized = trimmed.replace(/[^A-Za-z0-9_.:@/-]+/g, "_").replace(/^_+|_+$/g, "");
  return (normalized || fallback).slice(0, maxChars);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].toSorted();
}

function normalizeFlexibleMarkers(text: string): string {
  return text
    .replace(FLEX_BEGIN_RE, LEGACY_UNTRUSTED_RESULT_BEGIN)
    .replace(FLEX_END_RE, LEGACY_UNTRUSTED_RESULT_END);
}

function findParagraphStart(text: string, before: number): number {
  const bounded = Math.max(0, before - 16_384);
  const paragraph = text.lastIndexOf("\n\n", before);
  if (paragraph >= bounded) {
    return paragraph + 2;
  }
  return bounded;
}

function classifyRawText(
  text: string,
  options: ChildResultSanitizerOptions,
  markerClassifications: string[] = [],
): string[] {
  const classifications = [...markerClassifications];
  const byteCount = utf8Bytes(text);
  if (text.includes(LEGACY_UNTRUSTED_RESULT_BEGIN) || text.includes(LEGACY_UNTRUSTED_RESULT_END)) {
    classifications.push("marked_untrusted_child_result");
  }
  if (SOURCE_LIKE_RE.test(text)) {
    classifications.push("raw_source_like");
  }
  if (LOG_LIKE_RE.test(text)) {
    classifications.push("raw_log_like");
  }
  if (PROMPT_INJECTION_RE.test(text)) {
    classifications.push("prompt_injection_like");
  }
  if (hasNonTextCodePoint(text) || text.includes(NULL_BYTE)) {
    classifications.push("binary_like");
  }
  if (byteCount > 64 * 1024 || text.split("\n").length > 800) {
    classifications.push("huge_payload");
  }
  if (CHILD_CONTEXT_RE.test(text)) {
    classifications.push("child_result_context");
  }
  if (options.unsafeHint) {
    classifications.push("known_child_result_surface");
  }
  if (classifications.length === 0) {
    classifications.push("untrusted_child_result");
  }
  return unique(classifications);
}

function deterministicSummary(params: SegmentReplacement): string {
  const classes = unique(params.classifications);
  const summary = [
    `metadata-only`,
    `classes=${classes.join(",") || "untrusted_child_result"}`,
    params.surface ? `surface=${normalizeToken(params.surface, "unknown", 48)}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  return summary.slice(0, Math.max(32, params.maxSummaryChars ?? 180));
}

function replacementForSegment(params: SegmentReplacement): string {
  const hash = sha256Hex(params.raw);
  const bytes = utf8Bytes(params.raw);
  const state = normalizeState(params.normalizedState || params.raw.match(STATE_RE)?.[1]);
  const task = normalizeToken(params.taskLabel, "unknown", 64);
  const reason = normalizeToken(
    params.reason ?? unique(params.classifications).join(","),
    "classified",
    96,
  );
  const artifact = normalizeToken(params.artifactId, `sha256:${hash.slice(0, 16)}`, 96);
  const summary = deterministicSummary(params);
  return `${CHILD_RESULT_SANITIZED_PLACEHOLDER_PREFIX} task=${task}; state=${state}; reason=${reason}; artifact=${artifact}; sha256=${hash}; bytes=${bytes}; summary=${summary}]`;
}

function sanitizeMarkedSegments(
  text: string,
  options: ChildResultSanitizerOptions,
): {
  text: string;
  replacementCount: number;
  classifications: string[];
  byteCount: number;
  sha256: string;
} {
  const normalized = normalizeFlexibleMarkers(text);
  let cursor = 0;
  let output = "";
  let replacementCount = 0;
  const allClassifications: string[] = [];
  let aggregateBytes = 0;
  let aggregateHashInput = "";

  while (cursor < normalized.length) {
    const begin = normalized.indexOf(LEGACY_UNTRUSTED_RESULT_BEGIN, cursor);
    const end = normalized.indexOf(LEGACY_UNTRUSTED_RESULT_END, cursor);
    if (begin === -1 && end === -1) {
      output += normalized.slice(cursor);
      break;
    }

    if (end !== -1 && (begin === -1 || end < begin)) {
      const start = findParagraphStart(normalized, end);
      output += normalized.slice(cursor, start);
      const raw = normalized.slice(start, end + LEGACY_UNTRUSTED_RESULT_END.length);
      const classifications = classifyRawText(raw, options, ["missing_begin_marker"]);
      output += replacementForSegment({ raw, classifications, ...options });
      allClassifications.push(...classifications);
      aggregateBytes += utf8Bytes(raw);
      aggregateHashInput += raw;
      replacementCount += 1;
      cursor = end + LEGACY_UNTRUSTED_RESULT_END.length;
      continue;
    }

    output += normalized.slice(cursor, begin);
    let depth = 1;
    let scan = begin + LEGACY_UNTRUSTED_RESULT_BEGIN.length;
    let segmentEnd = -1;
    while (scan < normalized.length) {
      const nextBegin = normalized.indexOf(LEGACY_UNTRUSTED_RESULT_BEGIN, scan);
      const nextEnd = normalized.indexOf(LEGACY_UNTRUSTED_RESULT_END, scan);
      if (nextEnd === -1) {
        break;
      }
      if (nextBegin !== -1 && nextBegin < nextEnd) {
        depth += 1;
        scan = nextBegin + LEGACY_UNTRUSTED_RESULT_BEGIN.length;
        continue;
      }
      depth -= 1;
      scan = nextEnd + LEGACY_UNTRUSTED_RESULT_END.length;
      if (depth === 0) {
        segmentEnd = scan;
        break;
      }
    }

    const raw = normalized.slice(begin, segmentEnd === -1 ? normalized.length : segmentEnd);
    const markerClassifications =
      segmentEnd === -1 ? ["missing_end_marker"] : depth > 0 ? ["nested_marker"] : [];
    if (
      (raw.match(
        new RegExp(LEGACY_UNTRUSTED_RESULT_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      )?.length ?? 0) > 1
    ) {
      markerClassifications.push("nested_marker");
    }
    const classifications = classifyRawText(raw, options, markerClassifications);
    output += replacementForSegment({ raw, classifications, ...options });
    allClassifications.push(...classifications);
    aggregateBytes += utf8Bytes(raw);
    aggregateHashInput += raw;
    replacementCount += 1;
    cursor = segmentEnd === -1 ? normalized.length : segmentEnd;
  }

  return {
    text: output,
    replacementCount,
    classifications: unique(allClassifications),
    byteCount: aggregateBytes,
    sha256: aggregateHashInput ? sha256Hex(aggregateHashInput) : sha256Hex(""),
  };
}

function shouldSanitizeWholeText(text: string, options: ChildResultSanitizerOptions): boolean {
  if (!text || CHILD_RESULT_SANITIZED_PLACEHOLDER_RE.test(text)) {
    return false;
  }
  const normalized = normalizeFlexibleMarkers(text);
  if (
    normalized.includes(LEGACY_UNTRUSTED_RESULT_BEGIN) ||
    normalized.includes(LEGACY_UNTRUSTED_RESULT_END)
  ) {
    return true;
  }
  const hasChildContext = CHILD_CONTEXT_RE.test(normalized);
  const sourceOrLog = SOURCE_LIKE_RE.test(normalized) || LOG_LIKE_RE.test(normalized);
  const injection = PROMPT_INJECTION_RE.test(normalized);
  const huge = utf8Bytes(normalized) > 64 * 1024 || normalized.split("\n").length > 800;
  const binaryLike = normalized.includes(NULL_BYTE);
  if (options.unsafeHint) {
    return sourceOrLog || injection || huge || binaryLike || hasChildContext;
  }
  return hasChildContext && (sourceOrLog || injection || huge || binaryLike);
}

export function sanitizeChildResultText(
  text: string,
  options: ChildResultSanitizerOptions = {},
): SanitizedChildResult {
  try {
    if (!text) {
      return {
        sanitizedText: text,
        changed: false,
        replacementCount: 0,
        classifications: [],
        byteCount: 0,
        sha256: sha256Hex(""),
        summary: "unchanged",
      };
    }
    const markerSanitized = sanitizeMarkedSegments(text, options);
    let sanitizedText = markerSanitized.text;
    let replacementCount = markerSanitized.replacementCount;
    let classifications = markerSanitized.classifications;
    let byteCount = markerSanitized.byteCount;
    let hashInput = replacementCount > 0 ? text : "";

    if (replacementCount === 0 && shouldSanitizeWholeText(text, options)) {
      classifications = classifyRawText(text, options, ["unmarked_child_result"]);
      sanitizedText = replacementForSegment({ raw: text, classifications, ...options });
      replacementCount = 1;
      byteCount = utf8Bytes(text);
      hashInput = text;
    }

    const changed = sanitizedText !== text;
    return {
      sanitizedText,
      changed,
      replacementCount,
      classifications,
      byteCount,
      sha256: sha256Hex(hashInput),
      summary: changed
        ? deterministicSummary({ raw: hashInput, classifications, ...options })
        : "unchanged",
    };
  } catch {
    const raw = typeof text === "string" ? text : "";
    const classifications = ["sanitizer_failure", "fail_closed_metadata_only"];
    return {
      sanitizedText: replacementForSegment({ raw, classifications, ...options }),
      changed: true,
      replacementCount: 1,
      classifications,
      byteCount: utf8Bytes(raw),
      sha256: sha256Hex(raw),
      summary: "metadata-only; classes=sanitizer_failure,fail_closed_metadata_only",
    };
  }
}

export function sanitizeChildResultTextForModel(
  text: string,
  options: ChildResultSanitizerOptions = {},
): string {
  return sanitizeChildResultText(text, options).sanitizedText;
}

function sanitizeUnknownStrings(
  value: unknown,
  options: ChildResultSanitizerOptions,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const sanitized = sanitizeChildResultTextForModel(value, options);
    return { value: sanitized, changed: sanitized !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const sanitized = sanitizeUnknownStrings(item, options);
      changed = changed || sanitized.changed;
      return sanitized.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return { value, changed: false };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeUnknownStrings(child, options);
    changed = changed || sanitized.changed;
    next[key] = sanitized.value;
  }
  return { value: changed ? next : value, changed };
}

export function sanitizeChildResultValueForModel<T>(
  value: T,
  options: ChildResultSanitizerOptions = {},
): T {
  try {
    const sanitized = sanitizeUnknownStrings(value, options);
    return sanitized.changed ? (sanitized.value as T) : value;
  } catch {
    return sanitizeChildResultTextForModel("child result value sanitizer failure", {
      ...options,
      unsafeHint: true,
      reason: "sanitizer_failure",
    }) as T;
  }
}

export function sanitizeChildResultMessageForModel<T extends AgentMessage>(
  message: T,
  options: ChildResultSanitizerOptions = {},
): T {
  try {
    const sanitized = sanitizeUnknownStrings(message, options);
    return sanitized.changed ? (sanitized.value as T) : message;
  } catch {
    const content = sanitizeChildResultTextForModel("child result message sanitizer failure", {
      ...options,
      unsafeHint: true,
      reason: "sanitizer_failure",
    });
    const role =
      message && typeof message === "object" && "role" in message
        ? (message as { role?: unknown }).role
        : undefined;
    return {
      role: typeof role === "string" ? role : "assistant",
      content,
    } as T;
  }
}

export function sanitizeChildResultMessagesForModel<T extends AgentMessage>(
  messages: T[],
  options: ChildResultSanitizerOptions = {},
): T[] {
  let changed = false;
  const next = messages.map((message) => {
    const sanitized = sanitizeChildResultMessageForModel(message, options);
    changed = changed || sanitized !== message;
    return sanitized;
  });
  return changed ? next : messages;
}
