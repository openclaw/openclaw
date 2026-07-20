// Parses OpenAI/Qwen-style JSON tool calls emitted as plain assistant text.
import { isPlainTextToolNameChar, skipWhitespace, utf8ByteLengthWithinLimit } from "./grammar.js";

const MAX_TOOL_NAME_CHARS = 120;

export type OpenAiStyleToolCallBlock = {
  arguments: Record<string, unknown>;
  end: number;
  name: string;
  raw: string;
  start: number;
};

function findJsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}" && --depth === 0) {
      return index + 1;
    }
  }
  return undefined;
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

export function parseOpenAiStyleToolCallBlockAt(params: {
  text: string;
  start: number;
  allowedToolNames?: ReadonlySet<string>;
  maxPayloadBytes: number;
}): OpenAiStyleToolCallBlock | null {
  const objectStart = skipWhitespace(params.text, params.start);
  if (params.text[objectStart] !== "{") {
    return null;
  }
  const end = findJsonObjectEnd(params.text, objectStart);
  if (end === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.text.slice(objectStart, end)) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name || name.length > MAX_TOOL_NAME_CHARS) {
    return null;
  }
  for (const char of name) {
    if (!isPlainTextToolNameChar(char)) {
      return null;
    }
  }
  if (params.allowedToolNames && !params.allowedToolNames.has(name)) {
    return null;
  }
  const args = parseArguments(record.arguments ?? record.parameters ?? record.input);
  if (
    !args ||
    utf8ByteLengthWithinLimit(params.text, objectStart, end, params.maxPayloadBytes) === null
  ) {
    return null;
  }
  return {
    arguments: args,
    end,
    name,
    raw: params.text.slice(params.start, end),
    start: params.start,
  };
}
