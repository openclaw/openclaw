import { extractBalancedJsonPrefix } from "@openclaw/normalization-core";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as readTrimmedString } from "@openclaw/normalization-core/string-coerce";
import type { PlainTextToolCallNameMatcher } from "./contracts.js";
import { parseStandalonePlainTextToolCallBlocks } from "./payload.js";

type ToolCallShapedTextDetection = {
  kind: "json_tool_call" | "xml_tool_call" | "bracketed_tool_call" | "react_action";
  toolName?: string;
};

const TOOL_TEXT_PREFILTER_RE =
  /(?:tool[_\s-]?calls?|function[_\s-]?call|["'](?:name|tool_name|function|arguments|args|input|parameters|tool_calls)["']|<\s*tool_call\b|Action\s*:|\[END_TOOL_REQUEST\])/i;
const MAX_SCAN_CHARS = 20_000;
const MAX_JSON_CANDIDATES = 20;
const MAX_JSON_CANDIDATE_CHARS = 8_000;

function readToolName(record: Record<string, unknown>): string | undefined {
  return (
    readTrimmedString(record.name) ??
    readTrimmedString(record.tool_name) ??
    readTrimmedString(record.tool) ??
    readTrimmedString(record.function_name)
  );
}

function hasToolArgs(record: Record<string, unknown>): boolean {
  const parameters = asOptionalRecord(record.parameters);
  // Keep tool-definition schemas literal.
  return (
    "arguments" in record ||
    "args" in record ||
    "input" in record ||
    ("parameters" in record &&
      typeof record.description !== "string" &&
      record.type !== "function" &&
      parameters?.type !== "object" &&
      !asOptionalRecord(parameters?.properties))
  );
}

function classifyJsonValue(
  value: unknown,
  hasToolName?: PlainTextToolCallNameMatcher["hasExactName"],
): ToolCallShapedTextDetection | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const detection = classifyJsonValue(item, hasToolName);
      if (detection) {
        return detection;
      }
    }
    return null;
  }

  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }

  const toolCalls = record.tool_calls ?? record.toolCalls;
  if (Array.isArray(toolCalls)) {
    return (
      classifyJsonValue(toolCalls, hasToolName) ?? (hasToolName ? null : { kind: "json_tool_call" })
    );
  }

  const functionRecord = asOptionalRecord(
    record.function ?? record.function_call ?? record.functionCall,
  );
  if (functionRecord) {
    if (record.type === "function" && "parameters" in functionRecord) {
      return null;
    }
    const toolName = readToolName(functionRecord);
    if (toolName && (hasToolName?.(toolName) ?? true) && hasToolArgs(functionRecord)) {
      return { kind: "json_tool_call", toolName };
    }
  }

  const toolName = readToolName(record);
  if (toolName && hasToolName && !hasToolName(toolName)) {
    return null;
  }
  if (toolName && hasToolArgs(record)) {
    return { kind: "json_tool_call", toolName };
  }

  const type = readTrimmedString(record.type)?.toLowerCase();
  if (
    toolName &&
    (type === "tool_call" ||
      type === "toolcall" ||
      type === "tooluse" ||
      type === "tool_use" ||
      type === "function_call" ||
      type === "functioncall")
  ) {
    return { kind: "json_tool_call", toolName };
  }

  return null;
}

function* iterateJsonCandidates(text: string): Generator<string> {
  // Fenced candidates take precedence even when balanced JSON appears earlier.
  const fenceRe = /```(?:json|tool|tool_call|function_call)?[^\n\r]*[\r\n]([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRe)) {
    const candidate = match[1]?.trim();
    if (candidate && candidate.length <= MAX_JSON_CANDIDATE_CHARS) {
      yield candidate;
    }
  }

  let count = 0;
  for (let index = 0; index < text.length && count < MAX_JSON_CANDIDATES; index += 1) {
    const ch = text[index];
    if (ch !== "{" && ch !== "[") {
      continue;
    }
    // Bound each diagnostic scan even when prose contains many unmatched braces.
    const fragment = extractBalancedJsonPrefix(
      text.slice(index, index + MAX_JSON_CANDIDATE_CHARS + 1),
    );
    if (!fragment) {
      continue;
    }
    const candidate = fragment.json;
    if (candidate.length > 1) {
      count += 1;
      yield candidate;
    }
    index += fragment.endIndex;
  }
}

function detectJsonToolCall(text: string): ToolCallShapedTextDetection | null {
  for (const candidate of iterateJsonCandidates(text)) {
    try {
      const detection = classifyJsonValue(JSON.parse(candidate));
      if (detection) {
        return detection;
      }
    } catch {
      // Text only needs to be diagnostic-grade; malformed JSON stays text.
    }
  }
  return null;
}

function detectXmlToolCall(text: string): ToolCallShapedTextDetection | null {
  if (!/<\s*tool_call\b/i.test(text)) {
    return null;
  }
  if (!/<\s*function=/i.test(text) && !/["']name["']\s*:\s*["'][^"']{1,120}["']/i.test(text)) {
    return null;
  }
  const toolName =
    /<\s*function=([A-Za-z0-9_.:-]{1,120})\b/i.exec(text)?.[1] ??
    /["']name["']\s*:\s*["']([^"']{1,120})["']/i.exec(text)?.[1]?.trim();
  return { kind: "xml_tool_call", ...(toolName ? { toolName } : {}) };
}

const LEGACY_TOOL_CALL_OPEN_RE = /\[\s*TOOL_CALL\s*\]\s*{/gi;
const LEGACY_TOOL_NAME_RE = /\btool\s*=>\s*["']([A-Za-z_][A-Za-z0-9_.:-]{0,119})["']/gi;
const LEGACY_ARGS_RE = /\bargs\s*=>/gi;
const LEGACY_FIELD_GAP_CHARS = 8_000;

// `[TOOL_CALL] { tool => "name", args => ... }`: the leftmost opener whose first
// `tool =>` within 8,000 characters is followed by `args =>` within another 8,000.
// Matches of each part never overlap, so both passes only move forward.
function findLegacyBracketedToolName(text: string): string | undefined {
  const argsStarts = Array.from(text.matchAll(LEGACY_ARGS_RE), (match) => match.index);
  const callable: Array<{ start: number; name: string }> = [];
  let nextArgs = 0;
  for (const match of text.matchAll(LEGACY_TOOL_NAME_RE)) {
    const end = match.index + match[0].length;
    while (nextArgs < argsStarts.length && argsStarts[nextArgs]! < end) {
      nextArgs += 1;
    }
    if (nextArgs < argsStarts.length && argsStarts[nextArgs]! - end <= LEGACY_FIELD_GAP_CHARS) {
      callable.push({ start: match.index, name: match[1]! });
    }
  }
  let nextCallable = 0;
  for (const opener of text.matchAll(LEGACY_TOOL_CALL_OPEN_RE)) {
    const end = opener.index + opener[0].length;
    while (nextCallable < callable.length && callable[nextCallable]!.start < end) {
      nextCallable += 1;
    }
    const tool = callable[nextCallable];
    if (!tool) {
      return undefined;
    }
    if (tool.start - end <= LEGACY_FIELD_GAP_CHARS) {
      return tool.name;
    }
  }
  return undefined;
}

function detectBracketedToolCall(text: string): ToolCallShapedTextDetection | null {
  const legacyToolName = findLegacyBracketedToolName(text);
  if (legacyToolName) {
    return { kind: "bracketed_tool_call", toolName: legacyToolName };
  }

  const match =
    /^\s*\[([A-Za-z_][A-Za-z0-9_.:-]{0,119})\]\s+[\s\S]*?\[END_TOOL_REQUEST\]\s*$/i.exec(text);
  if (!match?.[1]) {
    return null;
  }
  return { kind: "bracketed_tool_call", toolName: match[1] };
}

function detectReactAction(text: string): ToolCallShapedTextDetection | null {
  const match =
    /(?:^|\n)[^\S\n]*Action\s*:\s*([A-Za-z_][A-Za-z0-9_.:-]{0,119})[^\S\n]*\n\s*Action Input\s*:/i.exec(
      text,
    );
  if (!match?.[1]) {
    return null;
  }
  return { kind: "react_action", toolName: match[1] };
}

/** Detects assistant-visible text that looks like an unexecuted tool call instead of prose. */
export function detectToolCallShapedText(text: string): ToolCallShapedTextDetection | null {
  const trimmed = text.slice(0, MAX_SCAN_CHARS).trim();
  if (!trimmed || !TOOL_TEXT_PREFILTER_RE.test(trimmed)) {
    return null;
  }
  return (
    detectBracketedToolCall(trimmed) ??
    detectXmlToolCall(trimmed) ??
    detectJsonToolCall(trimmed) ??
    detectReactAction(trimmed)
  );
}

// `<tool_call>body</tool_call>` (also `tool_calls`, `function_call`), closing tag in
// any case, body trimmed. A `\s*([\s\S]*?)\s*` body lets all three parts split one
// whitespace run, so the tags are checked directly.
function unwrapToolCallTag(text: string): string | undefined {
  const open = /^<(tool_calls?|function_call)>/i.exec(text);
  if (!open) {
    return undefined;
  }
  const close = `</${open[1]!}>`;
  if (text.length < open[0].length + close.length) {
    return undefined;
  }
  if (text.slice(-close.length).toLowerCase() !== close.toLowerCase()) {
    return undefined;
  }
  return text.slice(open[0].length, text.length - close.length).trim();
}

function isStructuredCall(
  text: string,
  hasToolName: PlainTextToolCallNameMatcher["hasExactName"],
): boolean {
  const body = unwrapToolCallTag(text) ?? text;
  const detection = classifyJsonValue(safeParseJson(body), hasToolName);
  if (detection?.toolName) {
    return true;
  }
  if (parseStandalonePlainTextToolCallBlocks(body)?.some((block) => hasToolName(block.name))) {
    return true;
  }
  const invoke =
    /^<(invoke|tool_call|function_call)\s+name=["']([^"']+)["']\s*>[\s\S]*<\/\1>$/i.exec(body);
  if (invoke && hasToolName(invoke[2] ?? "")) {
    return true;
  }
  const action =
    /^Action[ \t]*:[ \t]*([A-Za-z_][A-Za-z0-9_.:-]{0,119})[ \t]*\r?\n[ \t]*Action Input[ \t]*:[ \t]*([\s\S]+)$/i.exec(
      body,
    );
  if (action) {
    const input = action[2]?.trim() ?? "";
    // JSON-shaped input must be complete; multiline prose is not a ReAct call.
    return (
      hasToolName(action[1] ?? "") &&
      Boolean(input) &&
      (!/^[{["]|[\r\n]/.test(input) || safeParseJson(input) !== undefined)
    );
  }
  const legacy =
    /^\[\s*TOOL_CALL\s*\]\s*\{\s*tool\s*=>\s*(["'])([A-Za-z_][A-Za-z0-9_.:-]{0,119})\1\s*,\s*args\s*=>\s*(\{[\s\S]*\})\s*\}\s*\[\s*\/TOOL_CALL\s*\]$/i.exec(
      body,
    );
  return Boolean(
    legacy && hasToolName(legacy[2] ?? "") && asOptionalRecord(safeParseJson(legacy[3] ?? "")),
  );
}

// Text ending in a fenced block: `prefix`, then the earliest opening fence line whose
// marker matches the final closing line, then `body` up to that closing line. The
// closing line is fixed by the end of the text, so each line start is tried once.
function splitTrailingFence(text: string): { prefix: string; body: string } | undefined {
  const marker = text.slice(-3);
  if (marker !== "```" && marker !== "~~~") {
    return undefined;
  }
  let closeLineStart = text.length - 3;
  while (
    closeLineStart > 0 &&
    (text[closeLineStart - 1] === " " || text[closeLineStart - 1] === "\t")
  ) {
    closeLineStart -= 1;
  }
  const closeNewline = closeLineStart - 1;
  if (closeNewline < 0 || text[closeNewline] !== "\n") {
    return undefined;
  }
  const openLine = /[ \t]*(```|~~~)(?:json|xml)?[ \t]*\r?\n/iy;
  for (let lineStart = 0; lineStart <= closeNewline;) {
    openLine.lastIndex = lineStart;
    const open = openLine.exec(text);
    const bodyStart = openLine.lastIndex;
    if (open?.[1] === marker && bodyStart <= closeNewline) {
      const bodyEnd =
        closeNewline > bodyStart && text[closeNewline - 1] === "\r"
          ? closeNewline - 1
          : closeNewline;
      return {
        prefix: text.slice(0, Math.max(0, lineStart - 1)),
        body: text.slice(bodyStart, bodyEnd),
      };
    }
    const nextNewline = text.indexOf("\n", lineStart);
    if (nextNewline < 0) {
      break;
    }
    lineStart = nextNewline + 1;
  }
  return undefined;
}

/** Detects a non-executable near miss; this must never be used to dispatch a tool. */
export function isPlainTextToolCallAttempt(
  text: string,
  hasToolName: PlainTextToolCallNameMatcher["hasExactName"],
): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 256_000) {
    return false;
  }
  if (isStructuredCall(trimmed, hasToolName)) {
    return true;
  }
  const fence = splitTrailingFence(trimmed);
  const trailing = /^([^\n]+)\n\s*((?:<|\{|\[|Action\s*:)[\s\S]*)$/i.exec(trimmed);
  const prefix = (fence?.prefix ?? trailing?.[1] ?? "").trim();
  const body = fence?.body ?? trailing?.[2];
  const announcement = /^(?:I(?:'ll| will| am going to)|Let me) (.+?)(?: now)?[.!:]?$/i.exec(
    prefix,
  )?.[1];
  const announcedTool =
    /^(?:call|invoke|run|execute|use) (?:the )?([A-Za-z_][A-Za-z0-9_.:-]*)(?: tool)?$/i.exec(
      announcement ?? "",
    )?.[1];
  const fileAnnouncement = /^(?:create|read|write|update|delete) the file$/i.test(
    announcement ?? "",
  );
  const toolLabel = /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(prefix) && hasToolName(prefix);
  // Accept only a tool label or complete action announcement, not explanatory prose.
  if (!body || (prefix && !toolLabel && !hasToolName(announcedTool ?? "") && !fileAnnouncement)) {
    return false;
  }
  return isStructuredCall(body.trim(), hasToolName);
}
