import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";
import { normalizeToolName } from "../../tool-policy.js";

type RecoveredTextToolCall = {
  start: number;
  end: number;
  name: string;
  arguments: Record<string, unknown>;
};

type TextRange = {
  start: number;
  end: number;
};

const MAX_RECOVERY_TEXT_CHARS = 32_000;
const MAX_INLINE_BACKTICK_RUNS = 256;
const MAX_XML_INVOKE_CANDIDATES = 8;
const MAX_XML_PARAMETER_CANDIDATES = 64;
const MAX_BARE_TEXT_TOOL_CALL_CANDIDATES = 8;

const BASIC_XML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#39);/i;
const XML_INVOKE_RE =
  /<invoke\b[^>]*\bname=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/invoke>(?:\s*<\/[a-z0-9:_-]+>)?/gi;
const XML_PARAMETER_RE =
  /<parameter\b[^>]*\bname=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/parameter>/gi;
const RECOVERABLE_XML_CONTAINER_SEGMENT_RE =
  /^\s*(?:<\/?(?:(?:[a-z0-9_-]+:)?(?:function_calls|tool_calls|tool_call))\s*>\s*)*$/i;
const TEXT_TOOL_CALL_START_RE = /(^|[\s([{"',;:])([A-Za-z][A-Za-z0-9_./-]*)\s*\(/g;

function countOccurrences(text: string, needle: string, maxCount: number): number {
  let count = 0;
  let searchIndex = 0;
  while (searchIndex < text.length) {
    const nextIndex = text.indexOf(needle, searchIndex);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    if (count > maxCount) {
      return count;
    }
    searchIndex = nextIndex + needle.length;
  }
  return count;
}

function exceedsInlineBacktickRunBudget(text: string): boolean {
  let runCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "`" || text[index - 1] === "`") {
      continue;
    }
    runCount += 1;
    if (runCount > MAX_INLINE_BACKTICK_RUNS) {
      return true;
    }
  }
  return false;
}

function shouldSkipRecoveryForText(text: string): boolean {
  if (!text || text.length > MAX_RECOVERY_TEXT_CHARS) {
    return true;
  }
  if (exceedsInlineBacktickRunBudget(text)) {
    return true;
  }
  return (
    countOccurrences(text.toLowerCase(), "<invoke", MAX_XML_INVOKE_CANDIDATES) >
    MAX_XML_INVOKE_CANDIDATES
  );
}

function decodeBasicXmlEntities(text: string): string {
  if (!BASIC_XML_ENTITY_RE.test(text)) {
    return text;
  }
  return text
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function parseLooseJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parseObjectToolArguments(text: string): Record<string, unknown> | undefined {
  const parsed = parseLooseJsonValue(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function consumeParenthesizedToolArgs(text: string, openIndex: number): number | null {
  if (text[openIndex] !== "(") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let stringDelimiter: "'" | '"' | null = null;
  let escape = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === stringDelimiter) {
        inString = false;
        stringDelimiter = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringDelimiter = ch;
      continue;
    }

    if (ch === "(") {
      depth += 1;
      continue;
    }

    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return null;
}

function resolveRecoveredToolCallName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!allowedToolNames || allowedToolNames.size === 0) {
    return normalizeToolName(trimmed);
  }

  if (allowedToolNames.has(trimmed)) {
    return trimmed;
  }

  const normalized = normalizeToolName(trimmed);
  let canonicalMatch: string | undefined;
  for (const allowedName of allowedToolNames) {
    if (normalizeToolName(allowedName) !== normalized) {
      continue;
    }
    if (canonicalMatch && canonicalMatch !== allowedName) {
      return undefined;
    }
    canonicalMatch = allowedName;
  }
  return canonicalMatch;
}

function isRecoverableOuterText(text: string): boolean {
  return !text.trim() || RECOVERABLE_XML_CONTAINER_SEGMENT_RE.test(text);
}

function findMarkdownCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];

  type FenceState = { start: number; markerChar: "`" | "~"; markerLength: number };
  const lineRanges: TextRange[] = [];
  let lineStart = 0;
  while (lineStart < text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd + 1;
    lineRanges.push({ start: lineStart, end });
    lineStart = end;
  }

  let openFence: FenceState | null = null;
  for (const lineRange of lineRanges) {
    const lineText = text.slice(lineRange.start, lineRange.end).replace(/\r?\n$/, "");

    if (openFence) {
      const closeRe = new RegExp(
        `^[ \\t]{0,3}${openFence.markerChar}{${openFence.markerLength},}[ \\t]*$`,
      );
      if (closeRe.test(lineText)) {
        ranges.push({ start: openFence.start, end: lineRange.end });
        openFence = null;
      }
      continue;
    }

    const fenceStartMatch = lineText.match(/^[ \t]{0,3}([`~]{3,})/);
    if (!fenceStartMatch) {
      continue;
    }
    const marker = fenceStartMatch[1] ?? "";
    const markerChar = marker[0] as "`" | "~" | undefined;
    if (!markerChar || !marker.split("").every((char) => char === markerChar)) {
      continue;
    }
    openFence = {
      start: lineRange.start,
      markerChar,
      markerLength: marker.length,
    };
  }

  if (openFence) {
    // Treat unterminated fences as code through end-of-text so incomplete
    // markdown examples are never recovered as executable tool calls.
    ranges.push({ start: openFence.start, end: text.length });
  }

  const fencedRanges = ranges.toSorted((a, b) => a.start - b.start || a.end - b.end);
  let fencedRangeIndex = 0;
  let currentIndentedBlock: TextRange | null = null;
  for (const lineRange of lineRanges) {
    const lineText = text.slice(lineRange.start, lineRange.end).replace(/\r?\n$/, "");

    while (true) {
      const fencedRange = fencedRanges[fencedRangeIndex];
      if (!fencedRange || fencedRange.end > lineRange.start) {
        break;
      }
      fencedRangeIndex += 1;
    }

    const activeFenceRange = fencedRanges[fencedRangeIndex];
    const overlapsFence = Boolean(
      activeFenceRange &&
      lineRange.start < activeFenceRange.end &&
      activeFenceRange.start < lineRange.end,
    );
    const isIndentedCodeLine = Boolean(lineText) && /^(\t| {4})/.test(lineText);
    if (!isIndentedCodeLine || overlapsFence) {
      if (currentIndentedBlock) {
        ranges.push(currentIndentedBlock);
        currentIndentedBlock = null;
      }
      continue;
    }

    if (!currentIndentedBlock) {
      currentIndentedBlock = { start: lineRange.start, end: lineRange.end };
      continue;
    }
    currentIndentedBlock.end = lineRange.end;
  }

  if (currentIndentedBlock) {
    ranges.push(currentIndentedBlock);
  }

  // Support inline spans delimited by one or more backticks (e.g. `code`,
  // ``code with `backticks` inside``) so snippet examples are not recovered.
  for (let index = 0; index < text.length; ) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }

    const start = index;
    let markerLength = 1;
    while (text[start + markerLength] === "`") {
      markerLength += 1;
    }

    let closeIndex = -1;
    let searchIndex = start + markerLength;
    while (searchIndex < text.length) {
      const nextTick = text.indexOf("`", searchIndex);
      if (nextTick === -1) {
        break;
      }
      let closeMarkerLength = 1;
      while (text[nextTick + closeMarkerLength] === "`") {
        closeMarkerLength += 1;
      }
      if (closeMarkerLength === markerLength) {
        // Match the exact delimiter width so spans like ``code `inside` code``
        // are treated as a single inline-code range.
        closeIndex = nextTick;
        break;
      }
      searchIndex = nextTick + closeMarkerLength;
    }

    if (closeIndex !== -1) {
      const end = closeIndex + markerLength;
      const overlapsExisting = ranges.some((range) => start < range.end && range.start < end);
      if (!overlapsExisting) {
        ranges.push({ start, end });
      }
      index = end;
      continue;
    }

    // Treat unterminated inline spans as code through end-of-text so incomplete
    // markdown examples are never recovered as executable tool calls.
    const overlapsExisting = ranges.some((range) => start < range.end && range.start < text.length);
    if (!overlapsExisting) {
      ranges.push({ start, end: text.length });
    }
    index = start + markerLength;
  }

  return ranges.toSorted((a, b) => a.start - b.start || a.end - b.end);
}

function isIndexInsideRange(index: number, ranges: TextRange[]): boolean {
  for (const range of ranges) {
    if (index < range.start) {
      return false;
    }
    if (index >= range.start && index < range.end) {
      return true;
    }
  }
  return false;
}

function findXmlTextToolCalls(
  text: string,
  allowedToolNames: Set<string> | undefined,
  codeRanges: TextRange[],
): RecoveredTextToolCall[] {
  const recovered: RecoveredTextToolCall[] = [];
  XML_INVOKE_RE.lastIndex = 0;
  let invokeCount = 0;

  for (const match of text.matchAll(XML_INVOKE_RE)) {
    invokeCount += 1;
    if (invokeCount > MAX_XML_INVOKE_CANDIDATES) {
      return [];
    }

    const start = match.index ?? 0;
    if (isIndexInsideRange(start, codeRanges)) {
      continue;
    }

    const rawName = (match[1] ?? match[2] ?? "").trim();
    if (!rawName) {
      continue;
    }

    const normalizedName = resolveRecoveredToolCallName(rawName, allowedToolNames);
    if (!normalizedName) {
      continue;
    }

    const body = match[3] ?? "";
    const args = Object.create(null) as Record<string, unknown>;
    if (
      countOccurrences(body.toLowerCase(), "<parameter", MAX_XML_PARAMETER_CANDIDATES) >
      MAX_XML_PARAMETER_CANDIDATES
    ) {
      continue;
    }

    XML_PARAMETER_RE.lastIndex = 0;
    let parameterCount = 0;
    for (const paramMatch of body.matchAll(XML_PARAMETER_RE)) {
      parameterCount += 1;
      if (parameterCount > MAX_XML_PARAMETER_CANDIDATES) {
        break;
      }
      const paramName = (paramMatch[1] ?? paramMatch[2] ?? "").trim();
      if (!paramName || isBlockedObjectKey(paramName)) {
        continue;
      }
      const rawValue = decodeBasicXmlEntities((paramMatch[3] ?? "").trim());
      const parsedValue = parseLooseJsonValue(rawValue);
      args[paramName] = parsedValue === undefined ? rawValue : parsedValue;
    }

    if (Object.keys(args).length === 0) {
      const parsedBodyArgs = parseObjectToolArguments(decodeBasicXmlEntities(body));
      if (parsedBodyArgs) {
        for (const [key, value] of Object.entries(parsedBodyArgs)) {
          if (isBlockedObjectKey(key)) {
            continue;
          }
          args[key] = value;
        }
      }
    }

    recovered.push({
      start,
      end: start + match[0].length,
      name: normalizedName,
      arguments: args,
    });
  }

  return recovered;
}

function findBareTextToolCalls(
  text: string,
  allowedToolNames: Set<string> | undefined,
  codeRanges: TextRange[],
): RecoveredTextToolCall[] {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return [];
  }

  const recovered: RecoveredTextToolCall[] = [];
  const textToolCallStartRe = new RegExp(
    TEXT_TOOL_CALL_START_RE.source,
    TEXT_TOOL_CALL_START_RE.flags,
  );
  let match: RegExpExecArray | null;
  let candidateCount = 0;
  while ((match = textToolCallStartRe.exec(text))) {
    candidateCount += 1;
    if (candidateCount > MAX_BARE_TEXT_TOOL_CALL_CANDIDATES) {
      return [];
    }

    const prefix = match[1] ?? "";
    const rawName = (match[2] ?? "").trim();
    if (!rawName) {
      continue;
    }

    const nameStart = (match.index ?? 0) + prefix.length;
    if (isIndexInsideRange(nameStart, codeRanges)) {
      continue;
    }

    const normalizedName = resolveRecoveredToolCallName(rawName, allowedToolNames);
    if (!normalizedName) {
      continue;
    }

    const parenIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
    const closeIndex = consumeParenthesizedToolArgs(text, parenIndex);
    if (closeIndex === null) {
      continue;
    }

    const args = parseObjectToolArguments(text.slice(parenIndex + 1, closeIndex - 1));
    if (!args) {
      continue;
    }

    let end = closeIndex;
    while (end < text.length && (text[end] === " " || text[end] === "\t")) {
      end += 1;
    }
    if (text[end] === ";") {
      end += 1;
    }

    recovered.push({ start: nameStart, end, name: normalizedName, arguments: args });
    textToolCallStartRe.lastIndex = end;
  }

  return recovered;
}

function splitTextBlockIntoRecoveredToolCalls(
  text: string,
  allowedToolNames?: Set<string>,
): Array<Pick<RecoveredTextToolCall, "name" | "arguments">> | null {
  if (shouldSkipRecoveryForText(text)) {
    return null;
  }

  const codeRanges = findMarkdownCodeRanges(text);
  const recovered = [
    ...findXmlTextToolCalls(text, allowedToolNames, codeRanges),
    ...findBareTextToolCalls(text, allowedToolNames, codeRanges),
  ].toSorted((a, b) => a.start - b.start || a.end - b.end);

  if (recovered.length === 0) {
    return null;
  }

  const nonOverlapping: RecoveredTextToolCall[] = [];
  let lastEnd = -1;
  for (const toolCall of recovered) {
    if (toolCall.start < lastEnd) {
      continue;
    }
    nonOverlapping.push(toolCall);
    lastEnd = toolCall.end;
  }

  let cursor = 0;
  for (const toolCall of nonOverlapping) {
    if (!isRecoverableOuterText(text.slice(cursor, toolCall.start))) {
      return null;
    }
    cursor = toolCall.end;
  }

  if (!isRecoverableOuterText(text.slice(cursor))) {
    return null;
  }

  return nonOverlapping.map((toolCall) => ({
    name: toolCall.name,
    arguments: toolCall.arguments,
  }));
}

function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

export function recoverTextToolCallsInMessage(
  message: unknown,
  allowedToolNames?: Set<string>,
): void {
  if (!message || typeof message !== "object" || !allowedToolNames || allowedToolNames.size === 0) {
    return;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return;
  }

  // Safety-first: if the model already emitted a structured tool call in this
  // message, avoid recovering additional text/XML calls from sibling text
  // blocks. This prevents accidental double-dispatch in mixed-content turns.
  if (
    content.some(
      (block) =>
        block &&
        typeof block === "object" &&
        isToolCallBlockType((block as { type?: unknown }).type),
    )
  ) {
    return;
  }

  const nextContent: unknown[] = [];
  let recoveredAny = false;

  for (const block of content) {
    if (
      !block ||
      typeof block !== "object" ||
      (block as { type?: unknown }).type !== "text" ||
      typeof (block as { text?: unknown }).text !== "string"
    ) {
      nextContent.push(block);
      continue;
    }

    const textBlock = block as { text: string } & Record<string, unknown>;
    const recoveredToolCalls = splitTextBlockIntoRecoveredToolCalls(
      textBlock.text,
      allowedToolNames,
    );
    if (!recoveredToolCalls) {
      nextContent.push(block);
      continue;
    }

    recoveredAny = true;
    for (const part of recoveredToolCalls) {
      nextContent.push({
        type: "toolCall",
        name: part.name,
        arguments: part.arguments,
      });
    }
  }

  if (!recoveredAny) {
    return;
  }

  (message as { content: unknown[] }).content = nextContent;
}

function wrapStreamRecoverTextToolCalls(
  stream: ReturnType<typeof streamSimple>,
  allowedToolNames?: Set<string>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    recoverTextToolCallsInMessage(message, allowedToolNames);
    return message;
  };

  return stream;
}

export function wrapStreamFnRecoverTextToolCalls(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamRecoverTextToolCalls(stream, allowedToolNames),
      );
    }
    return wrapStreamRecoverTextToolCalls(maybeStream, allowedToolNames);
  };
}
