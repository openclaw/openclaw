import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { normalizeToolName } from "../../tool-policy.js";

type RecoveredTextToolCall = {
  start: number;
  end: number;
  name: string;
  arguments: Record<string, unknown>;
};

type RecoveredTextToolPart =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; arguments: Record<string, unknown> };

type TextRange = {
  start: number;
  end: number;
};

const BASIC_XML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#39);/i;
const XML_INVOKE_RE =
  /<invoke\b[^>]*\bname=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/invoke>(?:\s*<\/[a-z0-9:_-]+>)?/gi;
const XML_PARAMETER_RE =
  /<parameter\b[^>]*\bname=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/parameter>/gi;
const TEXT_TOOL_CALL_START_RE = /(^|[\s([{"',;:])([A-Za-z][A-Za-z0-9_./-]*)\s*\(/g;

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

  const normalizedDelimiter = trimmed.replace(/\//g, ".");
  const segments = normalizedDelimiter
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  const candidates = new Set<string>([trimmed, normalizedDelimiter, normalizeToolName(trimmed)]);
  if (segments.length > 1) {
    for (let index = 1; index < segments.length; index += 1) {
      const suffix = segments.slice(index).join(".");
      candidates.add(suffix);
      candidates.add(normalizeToolName(suffix));
    }
  }

  if (!allowedToolNames || allowedToolNames.size === 0) {
    return [...candidates][0] ?? trimmed;
  }

  for (const candidate of candidates) {
    if (allowedToolNames.has(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    const folded = candidate.toLowerCase();
    for (const allowedName of allowedToolNames) {
      if (allowedName.toLowerCase() === folded) {
        return allowedName;
      }
    }
  }

  return undefined;
}

function findMarkdownCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];

  const fencedCodeRe = /```[\s\S]*?```/g;
  for (const match of text.matchAll(fencedCodeRe)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }

  const inlineCodeRe = /`[^`\r\n]*`/g;
  for (const match of text.matchAll(inlineCodeRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const overlapsExisting = ranges.some((range) => start < range.end && range.start < end);
    if (!overlapsExisting) {
      ranges.push({ start, end });
    }
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return ranges;
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

  for (const match of text.matchAll(XML_INVOKE_RE)) {
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
    const args: Record<string, unknown> = {};

    XML_PARAMETER_RE.lastIndex = 0;
    for (const paramMatch of body.matchAll(XML_PARAMETER_RE)) {
      const paramName = (paramMatch[1] ?? paramMatch[2] ?? "").trim();
      if (!paramName) {
        continue;
      }
      const rawValue = decodeBasicXmlEntities((paramMatch[3] ?? "").trim());
      const parsedValue = parseLooseJsonValue(rawValue);
      args[paramName] = parsedValue === undefined ? rawValue : parsedValue;
    }

    if (Object.keys(args).length === 0) {
      const parsedBodyArgs = parseObjectToolArguments(decodeBasicXmlEntities(body));
      if (parsedBodyArgs) {
        Object.assign(args, parsedBodyArgs);
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
  TEXT_TOOL_CALL_START_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEXT_TOOL_CALL_START_RE.exec(text))) {
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
    TEXT_TOOL_CALL_START_RE.lastIndex = end;
  }

  return recovered;
}

function splitTextBlockIntoRecoveredToolCalls(
  text: string,
  allowedToolNames?: Set<string>,
): RecoveredTextToolPart[] | null {
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

  const parts: RecoveredTextToolPart[] = [];
  let cursor = 0;
  for (const toolCall of nonOverlapping) {
    if (toolCall.start > cursor) {
      const textPart = text.slice(cursor, toolCall.start).trim();
      if (textPart) {
        parts.push({ type: "text", text: textPart });
      }
    }
    parts.push({
      type: "toolCall",
      name: toolCall.name,
      arguments: toolCall.arguments,
    });
    cursor = toolCall.end;
  }

  if (cursor < text.length) {
    const trailingText = text.slice(cursor).trim();
    if (trailingText) {
      parts.push({ type: "text", text: trailingText });
    }
  }

  return parts.length > 0 ? parts : null;
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
    const recoveredParts = splitTextBlockIntoRecoveredToolCalls(textBlock.text, allowedToolNames);
    if (!recoveredParts) {
      nextContent.push(block);
      continue;
    }

    recoveredAny = true;
    for (const part of recoveredParts) {
      if (part.type === "text") {
        nextContent.push({ ...textBlock, text: part.text });
        continue;
      }
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

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as { partial?: unknown; message?: unknown };
            recoverTextToolCallsInMessage(event.partial, allowedToolNames);
            recoverTextToolCallsInMessage(event.message, allowedToolNames);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
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
