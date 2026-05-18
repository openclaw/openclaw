import { createHash } from "node:crypto";

const PLACEHOLDER_PREFIX = "[OpenClaw sanitized child result:";
const PLACEHOLDER_RE = /\[OpenClaw sanitized child result:[^\]]*\]/;
const BEGIN = "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>";
const END = "<<<END_UNTRUSTED_CHILD_RESULT>>>";
const FLEX_BEGIN_RE =
  /(?:<\s*<\s*<\s*)?(?:\\n|\\r|\\t|\s)*BEGIN(?:\\n|\\r|\\t|\s|_|-)*UNTRUSTED(?:\\n|\\r|\\t|\s|_|-)*CHILD(?:\\n|\\r|\\t|\s|_|-)*RESULT(?:\\n|\\r|\\t|\s)*(?:>\s*>\s*>)?/gi;
const FLEX_END_RE =
  /(?:<\s*<\s*<\s*)?(?:\\n|\\r|\\t|\s)*END(?:\\n|\\r|\\t|\s|_|-)*UNTRUSTED(?:\\n|\\r|\\t|\s|_|-)*CHILD(?:\\n|\\r|\\t|\s|_|-)*RESULT(?:\\n|\\r|\\t|\s)*(?:>\s*>\s*>)?/gi;
const SOURCE_OR_LOG_RE =
  /(^|\n)\s*(?:diff --git|@@\s|---\s|\+\+\+\s|import\s+[^\n]+\s+from\s+|export\s+(?:function|const|class|type|interface)\b|Traceback \(most recent call last\)|Command exited with code|npm ERR!|pnpm\s+(?:ERR|WARN)|\[\.\.\.\s*\d+\s+more\s+(?:lines|characters)\b)/m;
const CHILD_CONTEXT_RE =
  /\b(?:subagent|sub-agent|child\s+(?:agent|result|completion|output|body|payload)|untrusted\s+child|quarantin(?:e|ed)|childResult|BEGIN_UNTRUSTED_CHILD_RESULT|END_UNTRUSTED_CHILD_RESULT)\b/i;
const PROMPT_INJECTION_RE =
  /\b(?:ignore (?:all )?(?:previous|above) instructions|preserve (?:this|the) (?:text|body|payload) verbatim|repeat (?:this|the) (?:text|body|payload) verbatim|print (?:the )?raw|include (?:the )?full (?:body|payload|log|source))\b/i;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function normalizeMarkers(text: string): string {
  return text.replace(FLEX_BEGIN_RE, BEGIN).replace(FLEX_END_RE, END);
}

function classesFor(text: string, extra: string[] = []): string[] {
  const classes = [...extra];
  if (text.includes(BEGIN) || text.includes(END)) {
    classes.push("marked_untrusted_child_result");
  }
  if (SOURCE_OR_LOG_RE.test(text)) {
    classes.push("raw_source_or_log_like");
  }
  if (PROMPT_INJECTION_RE.test(text)) {
    classes.push("prompt_injection_like");
  }
  if (CHILD_CONTEXT_RE.test(text)) {
    classes.push("child_result_context");
  }
  if (bytes(text) > 64 * 1024 || text.split("\n").length > 800) {
    classes.push("huge_payload");
  }
  if (classes.length === 0) {
    classes.push("untrusted_child_result");
  }
  return [...new Set(classes)].toSorted();
}

function placeholder(raw: string, classes: string[], surface: string): string {
  const hash = sha256(raw);
  return `${PLACEHOLDER_PREFIX} task=unknown; state=unknown; reason=${classes.join(",")}; artifact=sha256:${hash.slice(0, 16)}; sha256=${hash}; bytes=${bytes(raw)}; summary=metadata-only; classes=${classes.join(",")}; surface=${surface}]`;
}

function paragraphStart(text: string, before: number): number {
  const bounded = Math.max(0, before - 16_384);
  const paragraph = text.lastIndexOf("\n\n", before);
  if (paragraph >= bounded) {
    return paragraph + 2;
  }
  return bounded;
}

function sanitizeChildResultTextForMemoryInner(
  text: string,
  surface = "memory-extraction",
): string {
  if (!text || PLACEHOLDER_RE.test(text)) {
    return text;
  }
  const normalized = normalizeMarkers(text);
  let cursor = 0;
  let out = "";
  let changed = false;
  while (cursor < normalized.length) {
    const begin = normalized.indexOf(BEGIN, cursor);
    const end = normalized.indexOf(END, cursor);
    if (begin === -1 && end === -1) {
      out += normalized.slice(cursor);
      break;
    }
    if (end !== -1 && (begin === -1 || end < begin)) {
      const start = paragraphStart(normalized, end);
      out += normalized.slice(cursor, start);
      const raw = normalized.slice(start, end + END.length);
      out += placeholder(raw, classesFor(raw, ["missing_begin_marker"]), surface);
      cursor = end + END.length;
      changed = true;
      continue;
    }
    out += normalized.slice(cursor, begin);
    let depth = 1;
    let scan = begin + BEGIN.length;
    let segmentEnd = -1;
    while (scan < normalized.length) {
      const nextBegin = normalized.indexOf(BEGIN, scan);
      const nextEnd = normalized.indexOf(END, scan);
      if (nextEnd === -1) {
        break;
      }
      if (nextBegin !== -1 && nextBegin < nextEnd) {
        depth += 1;
        scan = nextBegin + BEGIN.length;
        continue;
      }
      depth -= 1;
      scan = nextEnd + END.length;
      if (depth === 0) {
        segmentEnd = scan;
        break;
      }
    }
    const raw = normalized.slice(begin, segmentEnd === -1 ? normalized.length : segmentEnd);
    out += placeholder(
      raw,
      classesFor(raw, segmentEnd === -1 ? ["missing_end_marker"] : []),
      surface,
    );
    cursor = segmentEnd === -1 ? normalized.length : segmentEnd;
    changed = true;
  }
  if (changed) {
    return out;
  }
  const suspicious =
    CHILD_CONTEXT_RE.test(normalized) &&
    (SOURCE_OR_LOG_RE.test(normalized) ||
      PROMPT_INJECTION_RE.test(normalized) ||
      bytes(normalized) > 64 * 1024);
  return suspicious
    ? placeholder(normalized, classesFor(normalized, ["unmarked_child_result"]), surface)
    : text;
}

export function sanitizeChildResultTextForMemory(
  text: string,
  surface = "memory-extraction",
): string {
  try {
    return sanitizeChildResultTextForMemoryInner(text, surface);
  } catch {
    return placeholder(
      "child result memory sanitizer failure",
      ["sanitizer_failure", "fail_closed_metadata_only"],
      surface,
    );
  }
}
