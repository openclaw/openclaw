// JSON-shaped plain-text tool-call parsing shared by payload promotion,
// stream buffering, and visible-text stripping paths.

import { consumeLineBreak, skipLineIndentation, skipWhitespace } from "./grammar.js";
import type {
  PlainTextJsonToolCallState,
  PlainTextToolCallBlock,
  PlainTextToolCallParseOptions,
} from "./payload.js";

export { type PlainTextToolCallBlock, type PlainTextToolCallParseOptions } from "./payload.js";

export const DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES = 256_000;

/** Structural JSON-object scanner shared by parsing, stripping, and stream buffering. */
export function scanJsonObject(
  text: string,
  start: number,
): {
  end: number;
  kind: "complete" | "prefix";
  state: PlainTextJsonToolCallState;
} {
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
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          kind: "complete",
          end: index + 1,
          state: { depth, escaped, inString },
        };
      }
    }
  }
  return { kind: "prefix", end: text.length, state: { depth, escaped, inString } };
}

// Recognizes a flat JSON object that carries a tool-name + arguments pair,
// matching the same shapes that detectToolCallShapedText already classifies
// as "json_tool_call".
function readJsonToolName(record: Record<string, unknown>): string | undefined {
  const name = record.name;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  const alt = record.tool_name ?? record.tool ?? record.function_name;
  if (typeof alt === "string" && alt.trim()) {
    return alt.trim();
  }
  return undefined;
}

function hasJsonToolArgs(record: Record<string, unknown>): boolean {
  return "arguments" in record || "args" in record || "input" in record || "parameters" in record;
}

function readJsonToolArguments(record: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ["arguments", "args", "input", "parameters"]) {
    const val = record[key];
    if (val === undefined || val === null) {
      continue;
    }
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val);
        // Align with parseJsonArguments: only non-array objects are valid
        // argument records. No _value coercion — invalid or array-shaped
        // JSON must not become executable tool-call input.
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        return null;
      } catch {
        return null;
      }
    }
    // Only non-array objects are valid argument records.
    if (typeof val === "object" && !Array.isArray(val)) {
      return val as Record<string, unknown>;
    }
    return null;
  }
  return null;
}

function extractJsonToolCallNameAndArgs(
  record: Record<string, unknown>,
  options?: PlainTextToolCallParseOptions,
): { name: string; arguments: Record<string, unknown> }[] {
  const allowedToolNames = options?.allowedToolNames
    ? new Set(options.allowedToolNames)
    : undefined;

  // Format 1: {"tool_calls": [...]} — OpenAI wrapper.
  // Every entry must parse atomically: if any entry is malformed or lacks
  // valid arguments, the entire wrapper is rejected so we never silently
  // drop a model-emitted call while consuming the wrapper text.
  const toolCalls = record.tool_calls ?? record.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const results: { name: string; arguments: Record<string, unknown> }[] = [];
    for (const entry of toolCalls) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const tc = entry as Record<string, unknown>;
      let name: string | undefined;
      let args: Record<string, unknown> | null = null;
      const fn = tc.function;
      if (fn && typeof fn === "object" && !Array.isArray(fn)) {
        const fnRecord = fn as Record<string, unknown>;
        name = readJsonToolName(fnRecord);
        if (name && (!allowedToolNames || allowedToolNames.has(name))) {
          args = readJsonToolArguments(fnRecord);
        }
      }
      if (!name || !args) {
        name = readJsonToolName(tc);
        if (name && (!allowedToolNames || allowedToolNames.has(name))) {
          args = readJsonToolArguments(tc);
        }
      }
      if (!name || !args) {
        return [];
      }
      results.push({ name, arguments: args });
    }
    return results;
  }

  // Format 2: {"function": {"name": "...", "arguments": {...}}}
  const functionRecord = record.function;
  if (functionRecord && typeof functionRecord === "object" && !Array.isArray(functionRecord)) {
    const fn = functionRecord as Record<string, unknown>;
    const name = readJsonToolName(fn);
    if (name && (!allowedToolNames || allowedToolNames.has(name))) {
      const args = readJsonToolArguments(fn);
      if (args) {
        return [{ name, arguments: args }];
      }
    }
  }

  // Format 3: {"name": "...", "arguments": {...}}
  const flatName = readJsonToolName(record);
  if (flatName && hasJsonToolArgs(record)) {
    if (!allowedToolNames || allowedToolNames.has(flatName)) {
      const args = readJsonToolArguments(record);
      if (args) {
        return [{ name: flatName, arguments: args }];
      }
    }
  }

  // Format 4: {"name": "...", "type": "tool_call", ...}
  const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  if (
    flatName &&
    (type === "tool_call" ||
      type === "toolcall" ||
      type === "tooluse" ||
      type === "tool_use" ||
      type === "function_call" ||
      type === "functioncall")
  ) {
    if (!allowedToolNames || allowedToolNames.has(flatName)) {
      const args = readJsonToolArguments(record);
      if (args) {
        return [{ name: flatName, arguments: args }];
      }
    }
  }

  return [];
}

export function parseJsonToolCallBlocksAt(
  text: string,
  start: number,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock[] | null {
  const cursor = skipWhitespace(text, start);
  if (text[cursor] !== "{") {
    return null;
  }
  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  const json = scanJsonObject(text, cursor);
  if (json.kind !== "complete") {
    return null;
  }
  // Enforce the UTF-8 byte limit on the raw payload before parsing so
  // multibyte characters cannot smuggle a payload past the char-length guard
  // in scanJsonObject.
  const rawJson = text.slice(cursor, json.end);
  if (Buffer.byteLength(rawJson, "utf8") > maxPayloadBytes) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const results = extractJsonToolCallNameAndArgs(parsed as Record<string, unknown>, options);
  if (results.length === 0) {
    return null;
  }
  return results.map((result) => ({
    arguments: result.arguments,
    end: json.end,
    name: result.name,
    raw: rawJson,
    start: cursor,
  }));
}

// Returns the exclusive end offset of a standalone JSON tool-call block, or null
// when the JSON object at `start` is not an actual tool call. The stripper calls
// this to decide whether a line-start JSON object should be removed from visible
// text, so we must validate tool-call shape — ordinary JSON prose must survive.
export function parseJsonToolCallBlockEndAt(text: string, start: number): number | null {
  const blocks = parseJsonToolCallBlocksAt(text, start);
  if (!blocks || blocks.length === 0) {
    return null;
  }
  return blocks[0]!.end;
}

// Pre-scan helper for stripPlainTextToolCallBlocks: only strip JSON tool-call
// objects when every non-blank line is a JSON tool-call block. When a line-start
// JSON object like {"name":"read","arguments":{"path":"/tmp"}} sits next to
// ordinary prose, it is a user-visible example and must be preserved.
// Bracket / XML / Harmony blocks are not gated because their syntax is
// unambiguous tool-call markup that users do not naturally type.
export function shouldStripJsonBlocks(text: string): boolean {
  let foundJsonBlock = false;
  let probe = 0;
  while (probe < text.length) {
    const ls = probe === 0 || text[probe - 1] === "\n" || text[probe - 1] === "\r";
    if (!ls) {
      probe += 1;
      continue;
    }
    const bs = skipLineIndentation(text, probe);
    const je = parseJsonToolCallBlockEndAt(text, bs);
    if (je !== null) {
      foundJsonBlock = true;
      probe = je;
      const lb = consumeLineBreak(text, probe);
      if (lb !== null) {
        probe = lb;
      }
      continue;
    }
    // This line is not a JSON tool-call. Check for visible content.
    let hasContent = false;
    for (let i = bs; i < text.length && text[i] !== "\n" && text[i] !== "\r"; i++) {
      if (text[i] !== " " && text[i] !== "\t") {
        hasContent = true;
        break;
      }
    }
    if (hasContent) {
      return false;
    }
    const nl = text.indexOf("\n", probe);
    if (nl === -1) {
      break;
    }
    probe = nl + 1;
  }
  return foundJsonBlock;
}

// Fast heuristic: does partial JSON text resemble a tool-call object?
// When stream chunks start with `{` at line start we must decide whether to
// buffer (withhold from visible text) or emit immediately.  Buffering a
// false positive is cheap — the classifyPending gate replays non-tool-call
// JSON once the object completes.
export function looksLikeJsonToolCall(text: string): boolean {
  return (
    text.includes('"name"') ||
    text.includes('"tool_calls"') ||
    text.includes('"toolCalls"') ||
    text.includes('"function"') ||
    text.includes('"tool_name"') ||
    text.includes('"function_name"')
  );
}

// Stream-level JSON tool-call classification shared with the stream normalizer.
// When the buffered candidate starts with `{`, validate and classify: complete
// JSON that is a recognized tool call is kept for terminal promotion; incomplete
// JSON is held until the next chunk; non-tool-call JSON is replayed as text so
// ordinary JSON prose is never dropped.
export function tryClassifyJsonBuffer(
  text: string,
  bufferBytes: number,
  maxPayloadBytes: number,
):
  | { kind: "complete" }
  | { kind: "false-positive" }
  | { kind: "incomplete" }
  | {
      kind: "stripped";
      text: string;
    }
  | null {
  const jsonStart = skipLineIndentation(text, 0);
  if (text[jsonStart] !== "{") {
    return null;
  }
  const json = scanJsonObject(text, jsonStart);
  if (json.kind === "prefix") {
    return bufferBytes > maxPayloadBytes ? { kind: "false-positive" } : { kind: "incomplete" };
  }
  // Complete JSON object — validate shape before trying to parse blocks.
  // looksLikeJsonToolCall is the cheap pre-filter; parseJsonToolCallBlocksAt
  // does the full structural validation including argument presence.
  if (looksLikeJsonToolCall(text.slice(jsonStart))) {
    const blocks = parseJsonToolCallBlocksAt(text, jsonStart);
    if (blocks !== null && blocks.length > 0) {
      const afterJson = skipWhitespace(text, json.end);
      if (afterJson < text.length) {
        // Trailing text after a complete JSON tool call.  The normalizer
        // may duplicate the buffer when a suppress→candidate transition
        // re-appends the same chunk; treat the stronger leading match as
        // authoritative instead of yielding the trailing copy as text.
        const trailingJsonStart = skipLineIndentation(text, afterJson);
        if (
          text[trailingJsonStart] === "{" &&
          parseJsonToolCallBlocksAt(text, trailingJsonStart) !== null
        ) {
          return { kind: "complete" };
        }
        return { kind: "stripped", text: text.slice(afterJson) };
      }
      if (jsonStart > 0) {
        return { kind: "stripped", text: text.slice(0, jsonStart) };
      }
      return { kind: "complete" };
    }
  }
  // Complete JSON that is not a recognized tool call — replay as text.
  return { kind: "false-positive" };
}

// Stream event helpers shared with the stream normalizer.

export function eventTemplate(event: Record<string, unknown>): Record<string, unknown> {
  const template = { ...event };
  delete template.content;
  delete template.delta;
  delete template.partial;
  return template;
}

export function createSyntheticTextDelta(
  template: Record<string, unknown>,
  text: string,
  partial?: Record<string, unknown>,
): Record<string, unknown> {
  const event = eventTemplate(template);
  return {
    ...event,
    type: "text_delta",
    delta: text,
    ...(partial ? { partial } : {}),
  };
}
