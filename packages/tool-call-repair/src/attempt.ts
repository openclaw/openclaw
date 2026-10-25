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

function detectBracketedToolCall(text: string): ToolCallShapedTextDetection | null {
  const legacyMatch =
    /\[\s*TOOL_CALL\s*\]\s*{[\s\S]{0,8000}?\btool\s*=>\s*["']([A-Za-z_][A-Za-z0-9_.:-]{0,119})["'][\s\S]{0,8000}?\bargs\s*=>[\s\S]*?(?:\[\s*\/\s*TOOL_CALL\s*\]|$)/i.exec(
      text,
    );
  if (legacyMatch?.[1]) {
    return { kind: "bracketed_tool_call", toolName: legacyMatch[1] };
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
    /(?:^|\n)\s*Action\s*:\s*([A-Za-z_][A-Za-z0-9_.:-]{0,119})\s*(?:\r?\n)+\s*Action Input\s*:/i.exec(
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

function isStructuredCall(
  text: string,
  hasToolName: PlainTextToolCallNameMatcher["hasExactName"],
): boolean {
  const wrapper = /^<(tool_calls?|function_call)>\s*([\s\S]*?)\s*<\/\1>$/i.exec(text);
  const body = wrapper?.[2] ?? text;
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
  const fence =
    /^([\s\S]*?)(?:^|\n)[ \t]*(```|~~~)(?:json|xml)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\2$/i.exec(
      trimmed,
    );
  const trailing = /^([^\n]+)\n\s*((?:<|\{|\[|Action\s*:)[\s\S]*)$/i.exec(trimmed);
  const prefix = (fence?.[1] ?? trailing?.[1] ?? "").trim();
  const body = fence?.[3] ?? trailing?.[2];
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
