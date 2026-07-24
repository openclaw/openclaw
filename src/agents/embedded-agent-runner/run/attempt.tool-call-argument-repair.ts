/**
 * Repairs malformed tool-call arguments in embedded-agent stream results.
 */
import { extractBalancedJsonPrefix } from "../../../shared/balanced-json.js";
import { normalizeProviderId } from "../../model-selection.js";
import type { StreamFn } from "../../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { log } from "../logger.js";
import { createHtmlEntityToolCallArgumentDecodingWrapper } from "../tool-call-argument-decoding.js";
import { isRunnerToolCallBlockType } from "./attempt.tool-call-block-type.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";

const MAX_TOOLCALL_REPAIR_BUFFER_CHARS = 64_000;
const MAX_TOOLCALL_REPAIR_LEADING_CHARS = 96;
const MAX_TOOLCALL_REPAIR_TRAILING_CHARS = 3;
const TOOLCALL_REPAIR_ALLOWED_LEADING_RE = /^[a-z0-9\s"'`.:/_\\-]+$/i;
const TOOLCALL_REPAIR_ALLOWED_TRAILING_RE = /^[^\s{}[\]":,\\]{1,3}$/;
const TOOLCALL_REPAIR_RESPONSES_APIS = new Set([
  "azure-openai-responses",
  "openai-chatgpt-responses",
]);
const TOOLCALL_REPAIR_SMART_QUOTES = new Set(["\u201c", "\u201d", "\u201e", "\u201f"]);
const MAX_TOOLCALL_REPAIR_MEMBER_KEY_CHARS = 96;
const TOOLCALL_REPAIR_KNOWN_ARG_KEYS = new Set([
  "args",
  "backupDir",
  "cmd",
  "command",
  "content",
  "cwd",
  "edits",
  "file",
  "file_path",
  "filePath",
  "filepath",
  "from",
  "line_end",
  "line_start",
  "lines",
  "message",
  "new_str",
  "new_string",
  "newText",
  "old_str",
  "old_string",
  "oldText",
  "path",
  "paths",
  "pattern",
  "query",
  "replacement",
  "text",
  "timeoutMs",
  "title",
  "to",
  "url",
  "urls",
  "workdir",
]);
const TOOLCALL_REPAIR_FREEFORM_VALUE_KEYS = new Set([
  "content",
  "message",
  "new_str",
  "new_string",
  "newText",
  "old_str",
  "old_string",
  "oldText",
  "text",
]);
const TOOLCALL_REPAIR_FREEFORM_SUCCESSOR_KEYS: Record<string, string> = {
  old_str: "new_str",
  old_string: "new_string",
  oldText: "newText",
};

// Pattern: colon followed by literal \n then indent or consecutive
// escapes (\n\t) — fingerprint of double-escaped JSON in code blocks
// (issue #109478). Requires at least one whitespace or escape char
// between \n and the next code character so the fingerprint only
// triggers on actual indented code-block structure, not on shell
// commands or string literals that happen to contain colon-then-\n
// without indentation.
const TOOLCALL_REPAIR_DOUBLE_ESCAPED_CODE_RE = /:\s*\\n(?:\s|\\[nrt])+\S/s;

// Maps JSON escape chars to their real equivalents. Only applied at
// fingerprint positions, preserving intentional escapes elsewhere.
const TOOLCALL_REPAIR_DOUBLE_ESCAPE_MAP: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
};

// Matches corrupted \n, \t, \r at structural code positions: after a
// colon, semicolon, closing brace, another literal escape, or a real
// newline (result of a previous repair). Applied only after the
// fingerprint confirms this is an indented code block, so the
// lookahead intentionally uses * (not +) to also repair structural \n
// at non-indented positions (e.g. top-level def after a class body).
const TOOLCALL_REPAIR_DOUBLE_ESCAPED_REPLACE_RE =
  /((?::|;|\}|\\[nrt]|\n)\s*)\\([nrt])(?=(?:\s|\\[nrt])*\S)/gs;

// Code-like tool argument keys eligible for double-escape repair (#109478).
// Includes exec's "command" which is not in the smart-quote freeform set.
const TOOLCALL_REPAIR_DOUBLE_ESCAPED_CODE_KEYS = new Set([
  "command",
  ...TOOLCALL_REPAIR_FREEFORM_VALUE_KEYS,
]);

/**
 * Returns true when the position in `str` is inside matching Python-style
 * quotes (single or double), indicating a string literal rather than
 * code structure.  Real newlines reset quote state because Python string
 * literals cannot span lines without explicit continuation.
 */
function isInsideStringLiteral(str: string, pos: number): boolean {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < pos; i++) {
    const c = str[i];
    if (c === "\n") {
      inDouble = false;
      inSingle = false;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    }
  }
  return inDouble || inSingle;
}

/**
 * Returns true when every double-quoted span in `str` that contains a
 * Python keyword (def, class, if, for, while, with, try, except, import,
 * from, return, yield, pass, break, continue, raise, assert, del, global,
 * nonlocal) is treated as a code container rather than a string literal.
 * This prevents the quote check from skipping repairs inside `python -c`
 * and similar inline-code wrappers.
 */
function isInsideCodeContainer(str: string, pos: number): boolean {
  // Walk backward from pos to find the opening double-quote and then
  // check whether the text preceding it looks like a code launcher.
  let i = pos;
  while (i >= 0) {
    if (str[i] === '"') {
      // Check what comes before the opening quote.
      const before = str.slice(Math.max(0, i - 16), i);
      if (/(?:-\s*[ce]|python|node(?:\.exe)?)\s*$/i.test(before)) {
        return true;
      }
      // Check the quoted content for Python keywords (sampled — the
      // first 256 chars of the quoted region).
      const start = i + 1;
      const sample = str.slice(start, start + 256);
      if (/\b(?:def|class)\s+\w/.test(sample)) {
        return true;
      }
      break;
    }
    i--;
  }
  return false;
}

/** Fix double-escaped JSON strings in code-like tool call argument values. */
function repairDoubleEscapedCodeStrings(args: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      if (
        TOOLCALL_REPAIR_DOUBLE_ESCAPED_CODE_KEYS.has(key) &&
        TOOLCALL_REPAIR_DOUBLE_ESCAPED_CODE_RE.test(value)
      ) {
        // Loop so consecutive escapes (\n\t, \n\n) are all replaced.
        let repaired = value;
        for (let i = 0; i < 8; i++) {
          const prev = repaired;
          repaired = repaired.replace(
            TOOLCALL_REPAIR_DOUBLE_ESCAPED_REPLACE_RE,
            (_match, prefix, char, offset) => {
              // Skip replacements inside Python string literals
              // unless the quoted region is a code container
              // (e.g. python -c "...").  Position of the escape
              // char itself is offset + prefix.length.
              const escapePos = offset + prefix.length;
              if (
                isInsideStringLiteral(repaired, escapePos) &&
                !isInsideCodeContainer(repaired, escapePos)
              ) {
                return _match;
              }
              return `${prefix}${TOOLCALL_REPAIR_DOUBLE_ESCAPE_MAP[char] ?? char}`;
            },
          );
          repaired = repaired.replace(
            /\\([nrt])(?=\s*\\([nrt]))/gs,
            (_match, char) => TOOLCALL_REPAIR_DOUBLE_ESCAPE_MAP[char] ?? _match,
          );
          if (repaired === prev) {
            break;
          }
        }
        // Final cleanup: remaining escapes preceded by a real newline
        // (result of a prior repair) that were not matched because their
        // prefix character was not a structural token.
        repaired = repaired.replace(
          /(\n)\\([nrt])/g,
          (_match, nl) =>
            nl + (TOOLCALL_REPAIR_DOUBLE_ESCAPE_MAP[_match.slice(-1)] ?? _match.slice(-1)),
        );
        args[key] = repaired;
      }
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      repairDoubleEscapedCodeStrings(value as Record<string, unknown>);
    }
  }
}
const TOOLCALL_REPAIR_TOOL_VALUE_SUCCESSOR_KEYS = new Map<
  string,
  ReadonlyMap<string, readonly string[]>
>([["read", new Map([["path", ["offset", "limit"]]])]]);
const TOOLCALL_REPAIR_JSON_STRING_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function shouldAttemptMalformedToolCallRepair(partialJson: string, delta: string): boolean {
  if (/[}\]]/.test(delta)) {
    return true;
  }
  const trimmedDelta = delta.trim();
  return (
    trimmedDelta.length > 0 &&
    trimmedDelta.length <= MAX_TOOLCALL_REPAIR_TRAILING_CHARS &&
    /[}\]]/.test(partialJson)
  );
}

type ToolCallArgumentRepair = {
  args: Record<string, unknown>;
  kind: "preserved" | "repaired";
  leadingPrefix: string;
  trailingSuffix: string;
};

function isAllowedToolCallRepairLeadingPrefix(prefix: string): boolean {
  if (!prefix) {
    return true;
  }
  if (prefix.length > MAX_TOOLCALL_REPAIR_LEADING_CHARS) {
    return false;
  }
  if (!TOOLCALL_REPAIR_ALLOWED_LEADING_RE.test(prefix)) {
    return false;
  }
  return /^[.:'"`-]/.test(prefix) || /^(?:functions?|tools?)[._:/-]?/i.test(prefix);
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && char.trim() === "";
}

function skipWhitespace(raw: string, index: number): number {
  for (let i = index; i < raw.length; i += 1) {
    if (!isWhitespace(raw[i])) {
      return i;
    }
  }
  return raw.length;
}

function isToolCallRepairSmartQuote(char: string | undefined): boolean {
  return char !== undefined && TOOLCALL_REPAIR_SMART_QUOTES.has(char);
}

type ToolCallRepairStringToken = {
  value: string;
  endIndex: number;
};

type ToolCallRepairJsonValue = {
  value: unknown;
  endIndex: number;
};

type ToolCallRepairParsedObject = {
  args: Record<string, unknown>;
  endIndex: number;
};

function parseUsableObjectJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function findAsciiStringEnd(raw: string, startIndex: number): number {
  let escaped = false;
  for (let i = startIndex + 1; i < raw.length; i += 1) {
    const char = raw[i];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return i;
    }
  }
  return -1;
}

function readAsciiQuotedString(
  raw: string,
  startIndex: number,
): ToolCallRepairStringToken | undefined {
  const endIndex = findAsciiStringEnd(raw, startIndex);
  if (endIndex < 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw.slice(startIndex, endIndex + 1)) as unknown;
    return typeof parsed === "string" ? { value: parsed, endIndex: endIndex + 1 } : undefined;
  } catch {
    return undefined;
  }
}

function readSmartQuotedObjectKey(
  raw: string,
  startIndex: number,
): ToolCallRepairStringToken | undefined {
  let value = "";
  for (let i = startIndex + 1; i < raw.length; i += 1) {
    const char = raw[i];
    if (isToolCallRepairSmartQuote(char) && raw[skipWhitespace(raw, i + 1)] === ":") {
      return { value, endIndex: i + 1 };
    }
    value += char;
    if (value.length > MAX_TOOLCALL_REPAIR_MEMBER_KEY_CHARS) {
      return undefined;
    }
  }
  return undefined;
}

function readObjectKey(raw: string, startIndex: number): ToolCallRepairStringToken | undefined {
  const char = raw[startIndex];
  return char === '"'
    ? readAsciiQuotedString(raw, startIndex)
    : isToolCallRepairSmartQuote(char)
      ? readSmartQuotedObjectKey(raw, startIndex)
      : undefined;
}

function readObjectMemberKeyAfterComma(raw: string, commaIndex: number): string | undefined {
  const keyStart = skipWhitespace(raw, commaIndex + 1);
  const key = readObjectKey(raw, keyStart);
  if (!key || raw[skipWhitespace(raw, key.endIndex)] !== ":") {
    return undefined;
  }
  return key.value;
}

function normalizeToolCallRepairToolName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^[a-z0-9_-]{1,128}$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed.toLowerCase();
}

function extractToolNameFromLeadingPrefix(prefix: string): string | undefined {
  const match = /(?:^|[.\s])(?:functions?|tools?)[._:/-]?([a-z0-9_-]+)/i.exec(prefix);
  return match?.[1] ? normalizeToolCallRepairToolName(match[1]) : undefined;
}

function isToolSpecificValueSuccessor(params: {
  toolName?: string;
  valueKey: string;
  nextKey: string;
}): boolean {
  const toolName = params.toolName;
  if (!toolName) {
    return false;
  }
  return (
    TOOLCALL_REPAIR_TOOL_VALUE_SUCCESSOR_KEYS.get(toolName)
      ?.get(params.valueKey)
      ?.includes(params.nextKey) ?? false
  );
}

function shouldCloseSmartQuotedValueAt(
  raw: string,
  quoteIndex: number,
  valueKey: string,
  toolName?: string,
): boolean {
  const nextIndex = skipWhitespace(raw, quoteIndex + 1);
  const nextChar = raw[nextIndex];
  if (nextIndex >= raw.length || nextChar === "}") {
    return true;
  }
  if (nextChar !== ",") {
    return false;
  }

  const nextKey = readObjectMemberKeyAfterComma(raw, nextIndex);
  if (!nextKey) {
    return false;
  }
  if (!TOOLCALL_REPAIR_FREEFORM_VALUE_KEYS.has(valueKey)) {
    return (
      TOOLCALL_REPAIR_KNOWN_ARG_KEYS.has(nextKey) ||
      isToolSpecificValueSuccessor({ toolName, valueKey, nextKey })
    );
  }
  return TOOLCALL_REPAIR_FREEFORM_SUCCESSOR_KEYS[valueKey] === nextKey;
}

function decodeSmartQuotedJsonStringEscapes(value: string): string {
  return value.replace(/\\(?:(["\\/bfnrt])|u([0-9a-fA-F]{4}))/g, (match, escaped, hex) => {
    if (typeof hex === "string") {
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    return typeof escaped === "string"
      ? (TOOLCALL_REPAIR_JSON_STRING_ESCAPES[escaped] ?? match)
      : match;
  });
}

function readSmartQuotedValue(
  raw: string,
  startIndex: number,
  key: string,
  toolName?: string,
): ToolCallRepairJsonValue | undefined {
  let value = "";
  for (let i = startIndex + 1; i < raw.length; i += 1) {
    const char = raw[i];
    if (isToolCallRepairSmartQuote(char) && shouldCloseSmartQuotedValueAt(raw, i, key, toolName)) {
      return { value: decodeSmartQuotedJsonStringEscapes(value), endIndex: i + 1 };
    }
    value += char;
  }
  return undefined;
}

function readJsonValue(raw: string, startIndex: number): ToolCallRepairJsonValue | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < raw.length; i += 1) {
    const char = raw[i];
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
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      if (depth === 0) {
        return parseJsonValuePrefix(raw, startIndex, i);
      }
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      return parseJsonValuePrefix(raw, startIndex, i);
    }
  }
  return parseJsonValuePrefix(raw, startIndex, raw.length);
}

function parseJsonValuePrefix(
  raw: string,
  startIndex: number,
  endIndex: number,
): ToolCallRepairJsonValue | undefined {
  const json = raw.slice(startIndex, endIndex).trim();
  if (!json) {
    return undefined;
  }
  try {
    return { value: JSON.parse(json) as unknown, endIndex };
  } catch {
    return undefined;
  }
}

function readSmartQuotedEditArray(
  raw: string,
  startIndex: number,
): ToolCallRepairJsonValue | undefined {
  if (raw[startIndex] !== "[") {
    return undefined;
  }

  const edits: Record<string, unknown>[] = [];
  let index = skipWhitespace(raw, startIndex + 1);
  if (raw[index] === "]") {
    return { value: edits, endIndex: index + 1 };
  }

  while (index < raw.length) {
    const edit = parseSmartQuotedToolCallObject(raw, index);
    if (!edit) {
      return undefined;
    }
    edits.push(edit.args);

    index = skipWhitespace(raw, edit.endIndex);
    if (raw[index] === ",") {
      index = skipWhitespace(raw, index + 1);
      continue;
    }
    if (raw[index] === "]") {
      return { value: edits, endIndex: index + 1 };
    }
    return undefined;
  }

  return undefined;
}

function readObjectValue(
  raw: string,
  startIndex: number,
  key: string,
  toolName?: string,
): ToolCallRepairJsonValue | undefined {
  const char = raw[startIndex];
  if (char === '"') {
    return readAsciiQuotedString(raw, startIndex);
  }
  if (isToolCallRepairSmartQuote(char)) {
    return readSmartQuotedValue(raw, startIndex, key, toolName);
  }
  if (key === "edits" && char === "[") {
    return readSmartQuotedEditArray(raw, startIndex);
  }
  return readJsonValue(raw, startIndex);
}

function parseSmartQuotedToolCallObject(
  raw: string,
  startIndex: number,
  toolName?: string,
): ToolCallRepairParsedObject | undefined {
  if (raw[startIndex] !== "{") {
    return undefined;
  }
  const args: Record<string, unknown> = {};
  const seenKeys = new Set<string>();
  let index = skipWhitespace(raw, startIndex + 1);
  if (raw[index] === "}") {
    return { args, endIndex: index + 1 };
  }

  while (index < raw.length) {
    const key = readObjectKey(raw, index);
    if (!key || seenKeys.has(key.value)) {
      return undefined;
    }
    seenKeys.add(key.value);

    index = skipWhitespace(raw, key.endIndex);
    if (raw[index] !== ":") {
      return undefined;
    }

    const value = readObjectValue(raw, skipWhitespace(raw, index + 1), key.value, toolName);
    if (!value) {
      return undefined;
    }
    args[key.value] = value.value;

    index = skipWhitespace(raw, value.endIndex);
    if (raw[index] === ",") {
      index = skipWhitespace(raw, index + 1);
      continue;
    }
    if (raw[index] === "}") {
      return { args, endIndex: index + 1 };
    }
    return undefined;
  }

  return undefined;
}

function tryExtractUsableToolCallArgumentsFromJson(
  raw: string,
): ToolCallArgumentRepair | undefined {
  const extracted = extractBalancedJsonPrefix(raw);
  if (!extracted) {
    return undefined;
  }
  const leadingPrefix = raw.slice(0, extracted.startIndex).trim();
  if (!isAllowedToolCallRepairLeadingPrefix(leadingPrefix)) {
    return undefined;
  }
  const suffix = raw.slice(extracted.startIndex + extracted.json.length).trim();
  if (leadingPrefix.length === 0 && suffix.length === 0) {
    return undefined;
  }
  if (
    suffix.length > MAX_TOOLCALL_REPAIR_TRAILING_CHARS ||
    (suffix.length > 0 && !TOOLCALL_REPAIR_ALLOWED_TRAILING_RE.test(suffix))
  ) {
    return undefined;
  }

  const parsedExtracted = parseUsableObjectJson(extracted.json);
  if (!parsedExtracted) {
    return undefined;
  }
  return {
    args: parsedExtracted,
    kind: "repaired",
    leadingPrefix,
    trailingSuffix: suffix,
  };
}

function tryExtractSmartQuotedToolCallArguments(
  raw: string,
  toolNameFromContext?: string,
): ToolCallArgumentRepair | undefined {
  if (!/[\u201c\u201d\u201e\u201f]/.test(raw)) {
    return undefined;
  }
  const startIndex = raw.indexOf("{");
  if (startIndex < 0) {
    return undefined;
  }
  const leadingPrefix = raw.slice(0, startIndex).trim();
  if (!isAllowedToolCallRepairLeadingPrefix(leadingPrefix)) {
    return undefined;
  }
  const parsed = parseSmartQuotedToolCallObject(
    raw,
    startIndex,
    toolNameFromContext ?? extractToolNameFromLeadingPrefix(leadingPrefix),
  );
  if (!parsed) {
    return undefined;
  }
  const suffix = raw.slice(parsed.endIndex).trim();
  if (
    suffix.length > MAX_TOOLCALL_REPAIR_TRAILING_CHARS ||
    (suffix.length > 0 && !TOOLCALL_REPAIR_ALLOWED_TRAILING_RE.test(suffix))
  ) {
    return undefined;
  }
  return {
    args: parsed.args,
    kind: "repaired",
    leadingPrefix,
    trailingSuffix: suffix,
  };
}

function tryExtractUsableToolCallArguments(
  raw: string,
  toolNameFromContext?: string,
): ToolCallArgumentRepair | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const parsedRaw = parseUsableObjectJson(raw);
  if (parsedRaw) {
    return {
      args: parsedRaw,
      kind: "preserved",
      leadingPrefix: "",
      trailingSuffix: "",
    };
  }

  return (
    tryExtractUsableToolCallArgumentsFromJson(raw) ??
    tryExtractSmartQuotedToolCallArguments(raw, toolNameFromContext)
  );
}

function readToolCallNameInMessage(message: unknown, contentIndex: number): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const typedBlock = block as { type?: unknown; name?: unknown };
  if (!isRunnerToolCallBlockType(typedBlock.type) || typeof typedBlock.name !== "string") {
    return undefined;
  }
  return normalizeToolCallRepairToolName(typedBlock.name);
}

function repairToolCallArgumentsInMessage(
  message: unknown,
  contentIndex: number,
  repairedArgs: Record<string, unknown>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isRunnerToolCallBlockType(typedBlock.type)) {
    return;
  }
  typedBlock.arguments = repairedArgs;
}

function hasMeaningfulToolCallArgumentsInMessage(message: unknown, contentIndex: number): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return false;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isRunnerToolCallBlockType(typedBlock.type)) {
    return false;
  }
  return (
    typedBlock.arguments !== null &&
    typeof typedBlock.arguments === "object" &&
    !Array.isArray(typedBlock.arguments) &&
    Object.keys(typedBlock.arguments as Record<string, unknown>).length > 0
  );
}

function clearToolCallArgumentsInMessage(message: unknown, contentIndex: number): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isRunnerToolCallBlockType(typedBlock.type)) {
    return;
  }
  typedBlock.arguments = {};
}

function repairMalformedToolCallArgumentsInMessage(
  message: unknown,
  repairedArgsByIndex: Map<number, Record<string, unknown>>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const [index, repairedArgs] of repairedArgsByIndex.entries()) {
    repairToolCallArgumentsInMessage(message, index, repairedArgs);
  }
}

/** Walk message content blocks and repair double-escaped code strings in
 *  tool call arguments that were already valid JSON (unrepaired path). */
function repairDoubleEscapedCodeStringsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    if (!isRunnerToolCallBlockType(typedBlock.type)) {
      continue;
    }
    if (
      typedBlock.arguments !== null &&
      typeof typedBlock.arguments === "object" &&
      !Array.isArray(typedBlock.arguments)
    ) {
      repairDoubleEscapedCodeStrings(typedBlock.arguments as Record<string, unknown>);
    }
  }
}

function wrapStreamRepairMalformedToolCallArguments(
  stream: MutableAssistantMessageEventStream,
): MutableAssistantMessageEventStream {
  const partialJsonByIndex = new Map<number, string>();
  const repairedArgsByIndex = new Map<number, Record<string, unknown>>();
  const hadPreexistingArgsByIndex = new Set<number>();
  const disabledIndices = new Set<number>();
  const loggedRepairIndices = new Set<number>();
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    repairMalformedToolCallArgumentsInMessage(message, repairedArgsByIndex);
    repairDoubleEscapedCodeStringsInMessage(message);
    partialJsonByIndex.clear();
    repairedArgsByIndex.clear();
    hadPreexistingArgsByIndex.clear();
    disabledIndices.clear();
    loggedRepairIndices.clear();
    return message;
  };

  wrapStreamObjectEvents(stream, (event) => {
    if (
      typeof event.contentIndex === "number" &&
      Number.isInteger(event.contentIndex) &&
      event.type === "toolcall_delta" &&
      typeof event.delta === "string"
    ) {
      if (disabledIndices.has(event.contentIndex)) {
        return;
      }
      const nextPartialJson = (partialJsonByIndex.get(event.contentIndex) ?? "") + event.delta;
      if (nextPartialJson.length > MAX_TOOLCALL_REPAIR_BUFFER_CHARS) {
        partialJsonByIndex.delete(event.contentIndex);
        repairedArgsByIndex.delete(event.contentIndex);
        disabledIndices.add(event.contentIndex);
        return;
      }
      partialJsonByIndex.set(event.contentIndex, nextPartialJson);
      const shouldReevaluateRepair =
        shouldAttemptMalformedToolCallRepair(nextPartialJson, event.delta) ||
        repairedArgsByIndex.has(event.contentIndex);
      if (shouldReevaluateRepair) {
        const hadRepairState = repairedArgsByIndex.has(event.contentIndex);
        const toolName =
          readToolCallNameInMessage(event.partial, event.contentIndex) ??
          readToolCallNameInMessage(event.message, event.contentIndex);
        const repair = tryExtractUsableToolCallArguments(nextPartialJson, toolName);
        if (repair) {
          if (
            !hadRepairState &&
            (hasMeaningfulToolCallArgumentsInMessage(event.partial, event.contentIndex) ||
              hasMeaningfulToolCallArgumentsInMessage(event.message, event.contentIndex))
          ) {
            hadPreexistingArgsByIndex.add(event.contentIndex);
          }
          repairDoubleEscapedCodeStrings(repair.args);
          repairedArgsByIndex.set(event.contentIndex, repair.args);
          repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repair.args);
          repairToolCallArgumentsInMessage(event.message, event.contentIndex, repair.args);
          if (!loggedRepairIndices.has(event.contentIndex) && repair.kind === "repaired") {
            loggedRepairIndices.add(event.contentIndex);
            log.warn(
              `repairing malformed tool call arguments with ${repair.leadingPrefix.length} leading chars and ${repair.trailingSuffix.length} trailing chars`,
            );
          }
        } else {
          repairedArgsByIndex.delete(event.contentIndex);
          // Keep args that were already present on the streamed message, but
          // clear repair-only state so stale repaired args do not get replayed.
          const hadPreexistingArgs =
            hadPreexistingArgsByIndex.has(event.contentIndex) ||
            (!hadRepairState &&
              (hasMeaningfulToolCallArgumentsInMessage(event.partial, event.contentIndex) ||
                hasMeaningfulToolCallArgumentsInMessage(event.message, event.contentIndex)));
          if (!hadPreexistingArgs) {
            clearToolCallArgumentsInMessage(event.partial, event.contentIndex);
            clearToolCallArgumentsInMessage(event.message, event.contentIndex);
          }
        }
      }
    }
    if (
      typeof event.contentIndex === "number" &&
      Number.isInteger(event.contentIndex) &&
      event.type === "toolcall_end"
    ) {
      const repairedArgs = repairedArgsByIndex.get(event.contentIndex);
      if (repairedArgs) {
        repairDoubleEscapedCodeStrings(repairedArgs);
        if (event.toolCall && typeof event.toolCall === "object") {
          (event.toolCall as { arguments?: unknown }).arguments = repairedArgs;
        }
        repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repairedArgs);
        repairToolCallArgumentsInMessage(event.message, event.contentIndex, repairedArgs);
      }
      partialJsonByIndex.delete(event.contentIndex);
      hadPreexistingArgsByIndex.delete(event.contentIndex);
      disabledIndices.delete(event.contentIndex);
      loggedRepairIndices.delete(event.contentIndex);
    }
  });

  return stream;
}

export function wrapStreamFnRepairMalformedToolCallArguments(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamRepairMalformedToolCallArguments(stream),
      );
    }
    return wrapStreamRepairMalformedToolCallArguments(maybeStream);
  };
}

export function shouldRepairMalformedToolCallArguments(params: {
  provider?: string;
  modelApi?: string | null;
}): boolean {
  const modelApi = params.modelApi ?? "";
  return (
    (normalizeProviderId(params.provider ?? "") === "kimi" && modelApi === "anthropic-messages") ||
    modelApi === "openai-completions" ||
    TOOLCALL_REPAIR_RESPONSES_APIS.has(modelApi)
  );
}

export function wrapStreamFnDecodeXaiToolCallArguments(baseFn: StreamFn): StreamFn {
  return createHtmlEntityToolCallArgumentDecodingWrapper(baseFn);
}

/**
 * Wraps a stream function so double-escaped JSON strings in tool call
 * arguments are repaired before tool execution (#109478). Some models
 * output \\\\n (JSON literal backslash-n) instead of \\n (JSON-escaped
 * newline) in code-like argument values. This wrapper applies the repair
 * unconditionally for all providers.
 */
export function wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) => {
        const originalResult = stream.result.bind(stream);
        stream.result = async () => {
          const message = await originalResult();
          repairDoubleEscapedCodeStringsInMessage(message);
          return message;
        };
        return stream;
      });
    }
    const originalResult = maybeStream.result.bind(maybeStream);
    maybeStream.result = async () => {
      const message = await originalResult();
      repairDoubleEscapedCodeStringsInMessage(message);
      return message;
    };
    return maybeStream;
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
