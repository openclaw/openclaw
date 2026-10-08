import { extractBalancedJsonPrefix } from "@openclaw/normalization-core";
import { safeParseJson, safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeProviderId } from "../../model-selection.js";
import type { StreamFn } from "../../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { log } from "../logger.js";
import { isRunnerToolCallBlock } from "./attempt-tool-call-block-type.js";
import { mapAssistantMessageStream, wrapStreamObjectEvents } from "./stream-wrapper.js";

const MAX_TOOLCALL_REPAIR_BUFFER_CHARS = 64_000;
const MAX_TOOLCALL_REPAIR_LEADING_CHARS = 96;
const MAX_TOOLCALL_REPAIR_TRAILING_CHARS = 3;
const TOOLCALL_REPAIR_ALLOWED_LEADING_RE = /^[a-z0-9\s"'`.:/_\\-]+$/i;
const TOOLCALL_REPAIR_ALLOWED_TRAILING_RE = /^[^\s{}[\]":,\\]{1,3}$/;
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
  return (
    !prefix ||
    (prefix.length <= MAX_TOOLCALL_REPAIR_LEADING_CHARS &&
      TOOLCALL_REPAIR_ALLOWED_LEADING_RE.test(prefix) &&
      (/^[.:'"`-]/.test(prefix) || /^(?:functions?|tools?)[._:/-]?/i.test(prefix)))
  );
}

function skipWhitespace(raw: string, index: number): number {
  let next = index;
  while (next < raw.length && raw[next]?.trim() === "") {
    next += 1;
  }
  return next;
}

function isToolCallRepairSmartQuote(char: string | undefined): boolean {
  return char !== undefined && TOOLCALL_REPAIR_SMART_QUOTES.has(char);
}

type ToolCallRepairJsonValue<T = unknown> = {
  value: T;
  endIndex: number;
};

function findAsciiQuotedStringEnd(raw: string, startIndex: number): number | undefined {
  for (let i = startIndex + 1; i < raw.length; i += 1) {
    if (raw[i] === "\\") {
      i += 1;
    } else if (raw[i] === '"') {
      return i + 1;
    }
  }
  return undefined;
}

function readAsciiQuotedString(
  raw: string,
  startIndex: number,
): ToolCallRepairJsonValue<string> | undefined {
  const endIndex = findAsciiQuotedStringEnd(raw, startIndex);
  const parsed =
    endIndex === undefined ? undefined : safeParseJson(raw.slice(startIndex, endIndex));
  return typeof parsed === "string" && endIndex !== undefined
    ? { value: parsed, endIndex }
    : undefined;
}

function readSmartQuotedString(
  raw: string,
  startIndex: number,
  closesAt: (index: number) => boolean,
  maxChars = Infinity,
): ToolCallRepairJsonValue<string> | undefined {
  for (let i = startIndex + 1; i < raw.length; i += 1) {
    if (isToolCallRepairSmartQuote(raw[i]) && closesAt(i)) {
      return { value: raw.slice(startIndex + 1, i), endIndex: i + 1 };
    }
    if (i - startIndex > maxChars) {
      return undefined;
    }
  }
  return undefined;
}

function readObjectKey(
  raw: string,
  startIndex: number,
): ToolCallRepairJsonValue<string> | undefined {
  const char = raw[startIndex];
  return char === '"'
    ? readAsciiQuotedString(raw, startIndex)
    : isToolCallRepairSmartQuote(char)
      ? readSmartQuotedString(
          raw,
          startIndex,
          (index) => raw[skipWhitespace(raw, index + 1)] === ":",
          MAX_TOOLCALL_REPAIR_MEMBER_KEY_CHARS,
        )
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
  return /^[a-z0-9_-]{1,128}$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function extractToolNameFromLeadingPrefix(prefix: string): string | undefined {
  const match = /(?:^|[.\s])(?:functions?|tools?)[._:/-]?([a-z0-9_-]+)/i.exec(prefix);
  return match?.[1] ? normalizeToolCallRepairToolName(match[1]) : undefined;
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
      (toolName === "read" && valueKey === "path" && (nextKey === "offset" || nextKey === "limit"))
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

function readJsonValue(raw: string, startIndex: number): ToolCallRepairJsonValue | undefined {
  let depth = 0;
  for (let i = startIndex; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"') {
      const endIndex = findAsciiQuotedStringEnd(raw, i);
      if (endIndex === undefined) {
        return undefined;
      }
      i = endIndex - 1;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      if (depth === 0) {
        return parseJsonValuePrefix(raw, startIndex, i);
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
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
  const value = safeParseJson(raw.slice(startIndex, endIndex).trim());
  return value === undefined ? undefined : { value, endIndex };
}

function readCommaSeparatedBody(
  raw: string,
  startIndex: number,
  closing: "}" | "]",
  readEntry: (index: number) => number | undefined,
): number | undefined {
  let index = skipWhitespace(raw, startIndex + 1);
  if (raw[index] === closing) {
    return index + 1;
  }
  while (index < raw.length) {
    const endIndex = readEntry(index);
    if (endIndex === undefined) {
      return undefined;
    }
    index = skipWhitespace(raw, endIndex);
    if (raw[index] === ",") {
      index = skipWhitespace(raw, index + 1);
      continue;
    }
    return raw[index] === closing ? index + 1 : undefined;
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
    const parsed = readSmartQuotedString(raw, startIndex, (index) =>
      shouldCloseSmartQuotedValueAt(raw, index, key, toolName),
    );
    return parsed && { ...parsed, value: decodeSmartQuotedJsonStringEscapes(parsed.value) };
  }
  if (key === "edits" && char === "[") {
    const edits: Record<string, unknown>[] = [];
    const endIndex = readCommaSeparatedBody(raw, startIndex, "]", (index) => {
      const edit = parseSmartQuotedToolCallObject(raw, index);
      if (!edit) {
        return undefined;
      }
      edits.push(edit.value);
      return edit.endIndex;
    });
    return endIndex === undefined ? undefined : { value: edits, endIndex };
  }
  return readJsonValue(raw, startIndex);
}

function parseSmartQuotedToolCallObject(
  raw: string,
  startIndex: number,
  toolName?: string,
): ToolCallRepairJsonValue<Record<string, unknown>> | undefined {
  if (raw[startIndex] !== "{") {
    return undefined;
  }
  const args: Record<string, unknown> = {};
  const seenKeys = new Set<string>();
  const endIndex = readCommaSeparatedBody(raw, startIndex, "}", (index) => {
    const key = readObjectKey(raw, index);
    if (!key || seenKeys.has(key.value)) {
      return undefined;
    }
    seenKeys.add(key.value);

    const colonIndex = skipWhitespace(raw, key.endIndex);
    if (raw[colonIndex] !== ":") {
      return undefined;
    }

    const value = readObjectValue(raw, skipWhitespace(raw, colonIndex + 1), key.value, toolName);
    if (!value) {
      return undefined;
    }
    args[key.value] = value.value;
    return value.endIndex;
  });
  return endIndex === undefined ? undefined : { value: args, endIndex };
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
  return finishToolCallArgumentRepair(safeParseJsonRecord(extracted.json), leadingPrefix, suffix);
}

function finishToolCallArgumentRepair(
  args: Record<string, unknown> | undefined,
  leadingPrefix: string,
  trailingSuffix: string,
): ToolCallArgumentRepair | undefined {
  if (
    !args ||
    trailingSuffix.length > MAX_TOOLCALL_REPAIR_TRAILING_CHARS ||
    (trailingSuffix.length > 0 && !TOOLCALL_REPAIR_ALLOWED_TRAILING_RE.test(trailingSuffix))
  ) {
    return undefined;
  }
  return { args, kind: "repaired", leadingPrefix, trailingSuffix };
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
  return finishToolCallArgumentRepair(
    parsed.value,
    leadingPrefix,
    raw.slice(parsed.endIndex).trim(),
  );
}

function tryExtractUsableToolCallArguments(
  raw: string,
  toolNameFromContext?: string,
): ToolCallArgumentRepair | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const parsedRaw = safeParseJsonRecord(raw);
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

function readToolCallBlock(message: unknown, contentIndex: number) {
  const content = asOptionalObjectRecord(message)?.content;
  const block: unknown = Array.isArray(content) ? content[contentIndex] : undefined;
  return isRunnerToolCallBlock(block) ? block : undefined;
}

type ToolCallRepairState = {
  partialJson: string;
  repairedArgs?: Record<string, unknown>;
  hadPreexistingArgs?: boolean;
  disabled?: boolean;
  loggedRepair?: boolean;
};

function wrapStreamRepairMalformedToolCallArguments(
  stream: MutableAssistantMessageEventStream,
): MutableAssistantMessageEventStream {
  const stateByIndex = new Map<number, ToolCallRepairState>();
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    for (const [index, state] of stateByIndex) {
      const block = readToolCallBlock(message, index);
      if (block && state.repairedArgs) {
        block.arguments = state.repairedArgs;
      }
    }
    stateByIndex.clear();
    return message;
  };

  wrapStreamObjectEvents(stream, (event) => {
    const index = event.contentIndex;
    if (typeof index !== "number" || !Number.isInteger(index)) {
      return;
    }
    if (event.type === "toolcall_delta" && typeof event.delta === "string") {
      const state: ToolCallRepairState = stateByIndex.get(index) ?? { partialJson: "" };
      if (state.disabled) {
        return;
      }
      stateByIndex.set(index, state);
      state.partialJson += event.delta;
      if (state.partialJson.length > MAX_TOOLCALL_REPAIR_BUFFER_CHARS) {
        state.partialJson = "";
        state.repairedArgs = undefined;
        state.disabled = true;
        return;
      }
      const hadRepairState = state.repairedArgs !== undefined;
      if (
        !shouldAttemptMalformedToolCallRepair(state.partialJson, event.delta) &&
        !hadRepairState
      ) {
        return;
      }
      const blocks = [
        readToolCallBlock(event.partial, index),
        readToolCallBlock(event.message, index),
      ];
      const toolName = blocks
        .map((block) =>
          typeof block?.name === "string" ? normalizeToolCallRepairToolName(block.name) : undefined,
        )
        .find((name) => name !== undefined);
      const repair = tryExtractUsableToolCallArguments(state.partialJson, toolName);
      const hadPreexistingArgs =
        state.hadPreexistingArgs ||
        (!hadRepairState &&
          blocks.some(
            (block) => isRecord(block?.arguments) && Object.keys(block.arguments).length > 0,
          ));
      state.repairedArgs = repair?.args;
      if (repair) {
        state.hadPreexistingArgs = hadPreexistingArgs;
      }
      // Keep args that predate repair, but clear stale repair-only state.
      if (repair || !hadPreexistingArgs) {
        for (const block of blocks) {
          if (block) {
            block.arguments = repair?.args ?? {};
          }
        }
      }
      if (repair?.kind === "repaired" && !state.loggedRepair) {
        state.loggedRepair = true;
        log.warn(
          `repairing malformed tool call arguments with ${repair.leadingPrefix.length} leading chars and ${repair.trailingSuffix.length} trailing chars`,
        );
      }
    }
    if (event.type === "toolcall_end") {
      const repairedArgs = stateByIndex.get(index)?.repairedArgs;
      if (repairedArgs) {
        for (const block of [
          asOptionalObjectRecord(event.toolCall),
          readToolCallBlock(event.partial, index),
          readToolCallBlock(event.message, index),
        ]) {
          if (block) {
            block.arguments = repairedArgs;
          }
        }
        stateByIndex.set(index, { partialJson: "", repairedArgs });
      } else {
        stateByIndex.delete(index);
      }
    }
  });

  return stream;
}

export function wrapStreamFnRepairMalformedToolCallArguments(baseFn: StreamFn): StreamFn {
  return (model, context, options) =>
    mapAssistantMessageStream(
      baseFn(model, context, options),
      wrapStreamRepairMalformedToolCallArguments,
    );
}

export function shouldRepairMalformedToolCallArguments(params: {
  provider?: string;
  modelApi?: string | null;
}): boolean {
  const modelApi = params.modelApi ?? "";
  return (
    (normalizeProviderId(params.provider ?? "") === "kimi" && modelApi === "anthropic-messages") ||
    modelApi === "openai-completions" ||
    modelApi === "azure-openai-responses" ||
    modelApi === "openai-chatgpt-responses"
  );
}
