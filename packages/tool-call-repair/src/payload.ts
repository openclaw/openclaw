import { safeParseJsonRecord } from "@openclaw/normalization-core";
import {
  isOffsetInProtectedRanges,
  type PlainTextToolCallNameMatcher,
  type PlainTextToolCallParseOptions,
  type PlainTextToolCallProtectedRangeResolver,
} from "./contracts.js";
import {
  consumeLineBreak,
  consumeStructuralLineBreakAfterHorizontalWhitespace,
  END_TOOL_REQUEST,
  HARMONY_CALL_MARKER,
  HARMONY_CHANNEL_MARKER,
  HARMONY_MESSAGE_MARKER,
  isPlainTextToolNameChar,
  scanJsonObject,
  type JsonObjectScanState,
  scanToolCallNameEnd,
  scanXmlishToolCall,
  skipHorizontalWhitespace,
  skipLineIndentation,
  skipWhitespace,
  type StructuralLineBreakOptions,
  utf8ByteLengthWithinLimit,
} from "./grammar.js";

/** Parsed standalone plain-text tool call block with source offsets for repair. */
export type PlainTextToolCallBlock = {
  arguments: Record<string, unknown>;
  /** Exclusive end offset of the parsed block. */
  end: number;
  /** Tool name parsed from bracket, Harmony, or XML-ish syntax. */
  name: string;
  raw: string;
  /** Inclusive start offset of the parsed block. */
  start: number;
};

const DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES = 256_000;
const MAX_PLAIN_TEXT_TOOL_NAME_CHARS = 120;
const HARMONY_CHANNELS = ["commentary", "analysis", "final"] as const;
// Case folding only admits candidates; the canonical Harmony scanner retains its case rules.
const PLAIN_TEXT_TOOL_CALL_CANDIDATE_RE =
  /(?:^|[\r\n])[^\S\r\n]*(?:\[(?:tool:)?[A-Za-z0-9_-]+\]\s*(?:\{|<parameter=)|(?:<\|channel\|>)?(?:commentary|analysis|final)[ \t]+to=|<function=)/i;

export type PlainTextJsonToolCallSpan = { end: number; start: number };
export type PlainTextJsonToolCallSyntax = "harmony" | "named-bracket" | "tool-bracket";
export type PlainTextJsonToolCallState = JsonObjectScanState;
export type PlainTextJsonToolCallCandidate = {
  json?: PlainTextJsonToolCallState;
  name: PlainTextJsonToolCallSpan;
  nameComplete: boolean;
  payload?: PlainTextJsonToolCallSpan;
  syntax: PlainTextJsonToolCallSyntax;
};
export type PlainTextJsonToolCallScan =
  | { at: number; candidate?: PlainTextJsonToolCallCandidate; kind: "invalid" }
  | { candidate?: PlainTextJsonToolCallCandidate; kind: "prefix" }
  | (PlainTextJsonToolCallCandidate & {
      end: number;
      kind: "complete";
      nameComplete: true;
      payload: PlainTextJsonToolCallSpan;
    });

type PlainTextToolCallScanBranches = {
  json: PlainTextJsonToolCallScan;
  matches: { json: boolean; xmlish: boolean };
  xmlish: ReturnType<typeof scanXmlishToolCall>;
};

export type PlainTextToolCallScan = PlainTextToolCallScanBranches &
  (
    | {
        end: number;
        kind: "complete";
        next: number;
        overCap: boolean;
        payloadStart: number;
        settled: boolean;
      }
    | {
        completeEnd?: number;
        kind: "prefix";
        next: number;
        overCap: boolean;
        payloadStart?: number;
      }
    | {
        at: number;
        kind: "invalid";
        next: number;
        overCap: boolean;
        payloadStart?: number;
      }
  );

type PlainTextJsonToolCallOpening = {
  cursor: number;
  kind: "complete";
  value: PlainTextJsonToolCallCandidate & { nameComplete: true };
};
type PlainTextJsonToolCallOpeningScan =
  | PlainTextJsonToolCallOpening
  | Extract<PlainTextJsonToolCallScan, { kind: "invalid" | "prefix" }>;

function isLiteralPrefixAt(text: string, start: number, literal: string): boolean {
  const available = text.length - start;
  return start >= 0 && available < literal.length && literal.startsWith(text.slice(start));
}

function candidate<NameComplete extends boolean>(
  syntax: PlainTextJsonToolCallSyntax,
  name: PlainTextJsonToolCallSpan,
  nameComplete: NameComplete,
  payload?: PlainTextJsonToolCallSpan,
  json?: PlainTextJsonToolCallState,
): PlainTextJsonToolCallCandidate & { nameComplete: NameComplete } {
  return { syntax, name, nameComplete, ...(payload ? { payload } : {}), ...(json ? { json } : {}) };
}

function scanBracketOpening(
  text: string,
  start: number,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextJsonToolCallOpeningScan {
  let cursor = start + 1;
  let syntax: PlainTextJsonToolCallSyntax = "named-bracket";
  if (text.startsWith("tool:", cursor)) {
    syntax = "tool-bracket";
    cursor += "tool:".length;
  } else if (isLiteralPrefixAt(text, cursor, "tool:")) {
    return { kind: "prefix" };
  }
  const nameStart = cursor;
  const nameEnd = scanToolCallNameEnd(text, nameStart, isPlainTextToolNameChar);
  if (nameEnd - nameStart > MAX_PLAIN_TEXT_TOOL_NAME_CHARS) {
    return { kind: "invalid", at: nameStart + MAX_PLAIN_TEXT_TOOL_NAME_CHARS };
  }
  const name = { start: nameStart, end: nameEnd };
  cursor = nameEnd;
  if (cursor === text.length) {
    return {
      kind: "prefix",
      ...(nameStart === nameEnd ? {} : { candidate: candidate(syntax, name, false) }),
    };
  }
  if (nameStart === nameEnd || text[cursor] !== "]") {
    return { kind: "invalid", at: cursor };
  }
  cursor += 1;
  const value = candidate(syntax, name, true);
  if (syntax === "named-bracket") {
    const horizontalEnd = skipHorizontalWhitespace(text, cursor);
    if (horizontalEnd === text.length) {
      return { kind: "prefix", candidate: value };
    }
    const afterLineBreak = consumeStructuralLineBreakAfterHorizontalWhitespace(
      text,
      cursor,
      structuralLineBreaks,
    );
    if (afterLineBreak === null) {
      return { kind: "invalid", at: horizontalEnd, candidate: value };
    }
    cursor = afterLineBreak;
  }
  return { kind: "complete", cursor, value };
}

function scanHarmonyOpening(text: string, start: number): PlainTextJsonToolCallOpeningScan {
  let cursor = start;
  if (text.startsWith(HARMONY_CHANNEL_MARKER, cursor)) {
    cursor += HARMONY_CHANNEL_MARKER.length;
  } else if (isLiteralPrefixAt(text, cursor, HARMONY_CHANNEL_MARKER)) {
    return { kind: "prefix" };
  } else if (text[cursor] === "<") {
    return { kind: "invalid", at: cursor };
  }

  const channel = HARMONY_CHANNELS.find((value) => text.startsWith(value, cursor));
  if (!channel) {
    return HARMONY_CHANNELS.some((value) => isLiteralPrefixAt(text, cursor, value))
      ? { kind: "prefix" }
      : { kind: "invalid", at: cursor };
  }
  cursor += channel.length;
  if (cursor === text.length) {
    return { kind: "prefix" };
  }
  if (text[cursor] !== " " && text[cursor] !== "\t") {
    return { kind: "invalid", at: cursor };
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.startsWith("to=", cursor)) {
    return isLiteralPrefixAt(text, cursor, "to=")
      ? { kind: "prefix" }
      : { kind: "invalid", at: cursor };
  }
  cursor += "to=".length;

  const nameStart = cursor;
  const nameEnd = scanToolCallNameEnd(text, nameStart, isPlainTextToolNameChar);
  if (nameEnd - nameStart > MAX_PLAIN_TEXT_TOOL_NAME_CHARS) {
    return { kind: "invalid", at: nameStart + MAX_PLAIN_TEXT_TOOL_NAME_CHARS };
  }
  const name = { start: nameStart, end: nameEnd };
  cursor = nameEnd;
  if (cursor === text.length) {
    return {
      kind: "prefix",
      ...(nameStart === nameEnd ? {} : { candidate: candidate("harmony", name, false) }),
    };
  }
  if (nameStart === nameEnd || (text[cursor] !== " " && text[cursor] !== "\t")) {
    return { kind: "invalid", at: cursor };
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  const value = candidate("harmony", name, true);
  if (!text.startsWith("code", cursor)) {
    return isLiteralPrefixAt(text, cursor, "code")
      ? { kind: "prefix", candidate: value }
      : { kind: "invalid", at: cursor, candidate: value };
  }
  cursor = skipWhitespace(text, cursor + "code".length);
  if (text.startsWith(HARMONY_MESSAGE_MARKER, cursor)) {
    cursor = skipWhitespace(text, cursor + HARMONY_MESSAGE_MARKER.length);
  } else if (isLiteralPrefixAt(text, cursor, HARMONY_MESSAGE_MARKER)) {
    return { kind: "prefix", candidate: value };
  } else if (text[cursor] === "<") {
    return { kind: "invalid", at: cursor, candidate: value };
  }
  return { kind: "complete", cursor, value };
}

/** Uncapped structural scan shared by parsing, stripping, and stream buffering. */
export function scanPlainTextJsonToolCall(
  text: string,
  start = 0,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextJsonToolCallScan {
  const opening =
    text[start] === "["
      ? scanBracketOpening(text, start, structuralLineBreaks)
      : scanHarmonyOpening(text, start);
  if (opening.kind !== "complete") {
    return opening;
  }

  const value = opening.value;
  const payloadStart = skipWhitespace(text, opening.cursor);
  if (payloadStart === text.length) {
    return { kind: "prefix", candidate: value };
  }
  if (text[payloadStart] !== "{") {
    return { kind: "invalid", at: payloadStart, candidate: value };
  }

  const json = scanJsonObject(text, payloadStart);
  const payload = { start: payloadStart, end: json.end };
  if (json.kind === "prefix") {
    return {
      kind: "prefix",
      candidate: candidate(value.syntax, value.name, true, payload, json.state),
    };
  }

  const closingCandidate = candidate(value.syntax, value.name, true, payload, json.state);
  const namedBracket = value.syntax === "named-bracket";
  const closingStart = skipWhitespace(text, json.end);
  if (namedBracket && closingStart === text.length) {
    return { kind: "prefix", candidate: closingCandidate };
  }
  const name = text.slice(value.name.start, value.name.end);
  const closings = namedBracket
    ? [END_TOOL_REQUEST, `[/${name}]`]
    : [HARMONY_CALL_MARKER, END_TOOL_REQUEST, `[/${name}]`];
  for (const closing of closings) {
    if (text.startsWith(closing, closingStart)) {
      return { ...value, payload, kind: "complete", end: closingStart + closing.length };
    }
    if (closingStart < text.length && isLiteralPrefixAt(text, closingStart, closing)) {
      return { kind: "prefix", candidate: closingCandidate };
    }
  }
  return namedBracket
    ? { kind: "invalid", at: closingStart, candidate: closingCandidate }
    : { ...value, payload, kind: "complete", end: json.end };
}

/** Classifies one JSON/XML call candidate and provides monotonic scan progress. */
export function scanPlainTextToolCall(
  text: string,
  start = 0,
  options?: {
    matcher?: PlainTextToolCallNameMatcher;
    maxPayloadBytes?: number;
    structuralLineBreaks?: StructuralLineBreakOptions;
  },
): PlainTextToolCallScan {
  const xmlish = scanXmlishToolCall(text, start, options?.structuralLineBreaks);
  const json = scanPlainTextJsonToolCall(text, start, options?.structuralLineBreaks);
  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  const allowed = (
    scan: PlainTextToolCallScanBranches["json" | "xmlish"],
  ): {
    accepted: boolean;
    payload?: PlainTextJsonToolCallSpan;
  } => {
    const value = scan.kind === "complete" ? scan : scan.candidate;
    if (!value) {
      return { accepted: scan.kind === "prefix" };
    }
    const name = text.slice(value.name.start, value.name.end);
    const matches = value.nameComplete
      ? (options?.matcher?.hasExactName(name) ?? true)
      : (options?.matcher?.hasNamePrefix(name) ?? true);
    return matches
      ? { accepted: true, ...(value.payload ? { payload: value.payload } : {}) }
      : { accepted: false };
  };
  const xml = allowed(xmlish);
  const jsonValue = allowed(json);
  const branches = {
    json,
    matches: { json: jsonValue.accepted, xmlish: xml.accepted },
    xmlish,
  };
  const overCap = (payload?: PlainTextJsonToolCallSpan) =>
    Boolean(
      payload &&
      utf8ByteLengthWithinLimit(text, payload.start, payload.end, maxPayloadBytes) === null,
    );
  const xmlOverCap = overCap(xml.payload);
  const jsonOverCap = overCap(jsonValue.payload);
  const complete =
    xml.accepted && xmlish.kind === "complete"
      ? xmlish
      : jsonValue.accepted && json.kind === "complete"
        ? json
        : undefined;
  if (complete) {
    const payloadOverCap = complete === xmlish ? xmlOverCap : jsonOverCap;
    if (complete === xmlish || payloadOverCap || parseJsonArguments(text, complete.payload)) {
      return {
        ...branches,
        end: complete.end,
        kind: "complete",
        next: complete.end,
        overCap: payloadOverCap,
        payloadStart: complete.payload.start,
        settled:
          complete.end > complete.payload.end || skipWhitespace(text, complete.end) < text.length,
      };
    }
    return {
      ...branches,
      at: complete.end,
      kind: "invalid",
      next: complete.end,
      overCap: false,
      payloadStart: complete.payload.start,
    };
  }
  const invalid =
    xmlOverCap && xmlish.kind === "invalid"
      ? xmlish
      : jsonOverCap && json.kind === "invalid"
        ? json
        : undefined;
  if (invalid?.candidate?.payload) {
    return {
      ...branches,
      at: invalid.at,
      kind: "invalid",
      next: invalid.at,
      overCap: true,
      payloadStart: invalid.candidate.payload.start,
    };
  }

  const xmlPrefix = xml.accepted && xmlish.kind === "prefix";
  const jsonPrefix = jsonValue.accepted && json.kind === "prefix";
  if (xmlPrefix || jsonPrefix) {
    const payload = xmlPrefix ? xml.payload : jsonValue.payload;
    return {
      ...branches,
      ...(xmlish.kind === "prefix" && xmlish.completeEnd !== undefined
        ? { completeEnd: xmlish.completeEnd }
        : {}),
      kind: "prefix",
      next: text.length,
      overCap: xmlPrefix ? xmlOverCap : jsonOverCap,
      ...(payload ? { payloadStart: payload.start } : {}),
    };
  }

  let next = start + 1;
  if (xml.accepted) {
    next = Math.max(next, xmlish.kind === "invalid" ? xmlish.at : text.length);
  }
  if (jsonValue.accepted) {
    next = Math.max(
      next,
      json.kind === "complete" ? json.end : json.kind === "invalid" ? json.at : text.length,
    );
  }
  return { ...branches, at: next, kind: "invalid", next, overCap: false };
}

function parseJsonArguments(
  text: string,
  payload: PlainTextJsonToolCallSpan,
): Record<string, unknown> | null {
  return safeParseJsonRecord(text.slice(payload.start, payload.end)) ?? null;
}

function extractXmlishParameterValue(
  text: string,
  start: number,
  end: number,
  structuralLineBreaks?: StructuralLineBreakOptions,
): string {
  let value = text.slice(start, end);
  if (consumeLineBreak(text, skipHorizontalWhitespace(text, start)) === null) {
    const boundary = consumeStructuralLineBreakAfterHorizontalWhitespace(
      text,
      start,
      structuralLineBreaks,
    );
    if (boundary !== null) {
      const offset = boundary - start;
      value = `${value.slice(0, offset)}\n${value.slice(offset)}`;
    }
  }
  const payloadStart = consumeLineBreak(value, 0);
  if (payloadStart === null) {
    return value;
  }
  return value.slice(payloadStart).replace(/(?:\r\n|[\r\n])$/u, "");
}

export function parseStandalonePlainTextToolCallBlocks(
  text: string,
  options?: PlainTextToolCallParseOptions,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextToolCallBlock[] | null {
  const blocks: PlainTextToolCallBlock[] = [];
  const allowedToolNames = options?.allowedToolNames
    ? new Set(options.allowedToolNames)
    : undefined;
  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  let cursor = skipWhitespace(text, 0);
  while (cursor < text.length) {
    let block: PlainTextToolCallBlock | undefined;
    for (const scanCall of [scanPlainTextJsonToolCall, scanXmlishToolCall]) {
      const scan = scanCall(text, cursor, structuralLineBreaks);
      if (scan.kind !== "complete") {
        continue;
      }
      const name = text.slice(scan.name.start, scan.name.end);
      if (allowedToolNames && !allowedToolNames.has(name)) {
        continue;
      }
      if (
        utf8ByteLengthWithinLimit(text, scan.payload.start, scan.payload.end, maxPayloadBytes) ===
        null
      ) {
        continue;
      }
      const args =
        "parameters" in scan
          ? Object.fromEntries(
              scan.parameters.map((parameter) => [
                text.slice(parameter.name.start, parameter.name.end),
                extractXmlishParameterValue(
                  text,
                  parameter.value.start,
                  parameter.value.end,
                  structuralLineBreaks,
                ),
              ]),
            )
          : parseJsonArguments(text, scan.payload);
      if (args) {
        block = {
          arguments: args,
          end: scan.end,
          name,
          raw: text.slice(cursor, scan.end),
          start: cursor,
        };
        break;
      }
    }
    if (!block) {
      return null;
    }
    blocks.push(block);
    cursor = skipWhitespace(text, block.end);
  }
  return blocks.length > 0 ? blocks : null;
}

/** Removes full-line standalone plain-text tool-call blocks from user-visible text. */
export function stripPlainTextToolCallBlocks(
  text: string,
  options: { resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver } = {},
): string {
  if (!PLAIN_TEXT_TOOL_CALL_CANDIDATE_RE.test(text)) {
    return text;
  }
  return projectPlainTextToolCallBlocks(text, options).text;
}

/** Admit bracket JSON candidates without activating on ordinary brace prose. */
export function createPlainTextToolCallBraceProbe(): (delta: string) => boolean {
  let lineStart = true;
  let header = "";
  let awaitingPayload = "";
  return (delta) => {
    for (const char of delta) {
      if (char === "\r" || char === "\n") {
        lineStart = true;
        header = "";
        if (awaitingPayload && !awaitingPayload.endsWith("\n")) {
          awaitingPayload += "\n";
        }
        continue;
      }
      if (awaitingPayload) {
        if (/\s/u.test(char)) {
          continue;
        }
        // The canonical header parser owns names, limits, and required line breaks.
        const opening = char === "{" ? scanBracketOpening(awaitingPayload + char, 0) : undefined;
        awaitingPayload = "";
        if (opening?.kind === "complete") {
          return true;
        }
      }
      if (header) {
        header += char;
        if (char === "]") {
          awaitingPayload = header;
          header = "";
        } else if (
          /\s/u.test(char) ||
          header.length > MAX_PLAIN_TEXT_TOOL_NAME_CHARS + "[tool:]".length
        ) {
          header = "";
        }
        continue;
      }
      if (!lineStart || /[^\S\r\n]/u.test(char)) {
        continue;
      }
      lineStart = false;
      if (char === "[") {
        header = char;
      }
    }
    return false;
  };
}

/** Call-grammar settlement; callers also retain any mutable Markdown ownership. */
export function projectPlainTextToolCallBlocks(
  text: string,
  options: {
    resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver;
    settleBefore?: number;
  } = {},
): {
  text: string;
  retainStart: number;
  retainedOutputStart: number;
  unsettled: boolean;
} {
  let protectedRanges: ReturnType<PlainTextToolCallProtectedRangeResolver> | undefined;
  const isProtected = (offset: number) =>
    isOffsetInProtectedRanges(
      offset,
      (protectedRanges ??= options.resolveProtectedRanges?.(text) ?? []),
    );
  let result = "";
  let cursor = 0;
  let index = 0;
  let retainStart = 0;
  let retainedOutputStart = 0;
  let pending = false;
  while (index < text.length) {
    const lineStart = index === 0 || text[index - 1] === "\n" || text[index - 1] === "\r";
    if (!lineStart) {
      index += 1;
      continue;
    }
    if (!pending && index <= (options.settleBefore ?? text.length)) {
      retainStart = index;
      retainedOutputStart = result.length + index - cursor;
    }
    const blockStart = skipLineIndentation(text, index);
    if (
      (text[blockStart] === "[" ||
        text[blockStart] === "<" ||
        HARMONY_CHANNELS.some((channel) => channel[0] === text[blockStart])) &&
      isProtected(blockStart)
    ) {
      index += 1;
      continue;
    }
    const scan = scanPlainTextToolCall(text, blockStart);
    if (scan.kind === "invalid") {
      // The scanner owns everything before `at` as one malformed candidate. Honor that
      // progress so nested line starts inside its payload are not rescanned quadratically.
      index = Math.max(index + 1, scan.next);
      continue;
    }
    pending ||= scan.kind === "prefix" || !scan.settled;
    let blockEnd = scan.kind === "complete" ? scan.end : scan.completeEnd;
    if (blockEnd === undefined) {
      // A trailing candidate may still become a hidden call; the caller must not publish it.
      return {
        text: result + text.slice(cursor),
        retainStart,
        retainedOutputStart,
        unsettled: true,
      };
    }
    result += text.slice(cursor, index);
    while (true) {
      const adjacentStart = skipLineIndentation(text, blockEnd);
      if (isProtected(adjacentStart)) {
        break;
      }
      const adjacent = scanPlainTextToolCall(text, adjacentStart);
      pending ||= adjacent.kind === "prefix" || (adjacent.kind === "complete" && !adjacent.settled);
      const adjacentEnd =
        adjacent.kind === "complete"
          ? adjacent.end
          : adjacent.kind === "prefix"
            ? adjacent.completeEnd
            : undefined;
      if (adjacentEnd === undefined || adjacentEnd <= blockEnd) {
        break;
      }
      blockEnd = adjacentEnd;
    }
    const lineBreakStart = skipLineIndentation(text, blockEnd);
    cursor =
      lineBreakStart === text.length
        ? lineBreakStart
        : (consumeLineBreak(text, lineBreakStart) ?? blockEnd);
    index = cursor;
  }
  result += text.slice(cursor);
  // Keep a terminal CR until a possible LF settles newline consumption.
  if (!pending && text.endsWith("\n") && text.length <= (options.settleBefore ?? text.length)) {
    retainStart = text.length;
    retainedOutputStart = result.length;
  }
  return {
    text: result,
    retainStart,
    retainedOutputStart,
    unsettled: pending,
  };
}
