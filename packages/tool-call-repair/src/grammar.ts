/** Legacy marker some models emit after a serialized JSON tool request. */
export const END_TOOL_REQUEST = "[END_TOOL_REQUEST]";
/** Harmony stream marker that introduces the target channel before a tool call. */
export const HARMONY_CHANNEL_MARKER = "<|channel|>";
/** Harmony stream marker that may separate the header from the JSON payload. */
export const HARMONY_MESSAGE_MARKER = "<|message|>";
/** Harmony stream marker that may close a serialized tool-call payload. */
export const HARMONY_CALL_MARKER = "<|call|>";

/** Accepts either a complete literal or a still-streaming prefix of that literal. */
export function matchesLiteralPrefix(text: string, literal: string): boolean {
  return literal.startsWith(text) || text.startsWith(literal);
}

/** Tool names in bracket/plain-text repairs intentionally match provider-safe ids only. */
export function isPlainTextToolNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_-]/.test(char));
}

/** XML-ish function tags allow namespace punctuation used by some model families. */
export function isXmlishNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_.:-]/.test(char));
}

// Some proxies degrade native Anthropic/MiniMax tool calls into namespaced XML
// text (the attribute dialect: `<invoke name="..."><parameter name="...">`).
// Accept only this closed prefix allow-list so namespaced markup is repaired
// instead of leaking, without matching arbitrary `ns:` tokens in prose.
const TOOL_CALL_TAG_NAMESPACE = "(?:antml:|mm:)?";
// Open and close tags each carry the prefix independently, so a namespaced open
// can legitimately pair with a bare close (e.g. `<invoke>` … `</invoke>`)
// and vice versa. Degraded proxy output routinely drops the prefix on the close,
// so accepting any open/close prefix combination is intentional, not a bug.
/** Optional `<function_calls>` wrapper that brackets one or more invoke blocks. */
export const XMLISH_FUNCTION_CALLS_OPEN_RE = new RegExp(
  `^<\\s*${TOOL_CALL_TAG_NAMESPACE}function_calls\\s*>`,
  "i",
);
export const XMLISH_FUNCTION_CALLS_CLOSE_RE = new RegExp(
  `^<\\s*/\\s*${TOOL_CALL_TAG_NAMESPACE}function_calls\\s*>`,
  "i",
);
/** Attribute-dialect invoke open carrying the tool name in a quoted attribute. */
export const XMLISH_INVOKE_OPEN_RE = new RegExp(
  `^<\\s*${TOOL_CALL_TAG_NAMESPACE}invoke\\s+name\\s*=\\s*("[^"]*"|'[^']*')\\s*>`,
  "i",
);
export const XMLISH_INVOKE_CLOSE_RE = new RegExp(
  `^<\\s*/\\s*${TOOL_CALL_TAG_NAMESPACE}invoke\\s*>`,
  "i",
);
/** Parameter open in either the equals dialect (`<parameter=name>`) or the
 * attribute dialect (`<parameter name="...">`), optionally namespaced. */
export const XMLISH_PARAMETER_OPEN_RE = new RegExp(
  `^<\\s*${TOOL_CALL_TAG_NAMESPACE}parameter(?:=([A-Za-z0-9_.:-]{1,120})|\\s+name\\s*=\\s*("[^"]*"|'[^']*'))\\s*>`,
  "i",
);
export const XMLISH_PARAMETER_CLOSE_RE = new RegExp(
  `<\\s*/\\s*${TOOL_CALL_TAG_NAMESPACE}parameter\\s*>`,
  "i",
);

/** Removes the surrounding single or double quotes from a matched attribute value. */
export function stripXmlishAttributeQuotes(value: string): string {
  return value.slice(1, -1);
}

/** Returns the parameter name from a matched XMLISH_PARAMETER_OPEN_RE result. */
export function xmlishParameterName(match: RegExpExecArray): string | null {
  if (match[1]) {
    return match[1];
  }
  return match[2] ? stripXmlishAttributeQuotes(match[2]) : null;
}

/** Skips spaces and tabs only, preserving line boundaries for grammar decisions. */
export function skipHorizontalWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return index;
}

/** Skips all JavaScript whitespace when line structure is no longer meaningful. */
export function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

/** Consumes either Unix or Windows line endings and returns the first offset after them. */
export function consumeLineBreak(text: string, start: number): number | null {
  if (text[start] === "\r") {
    return text[start + 1] === "\n" ? start + 2 : start + 1;
  }
  if (text[start] === "\n") {
    return start + 1;
  }
  return null;
}

/** Finds the exclusive end offset of a balanced JSON object starting at `start`. */
export function findJsonObjectEnd(
  text: string,
  start: number,
  maxPayloadBytes?: number,
): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    if (maxPayloadBytes !== undefined && index + 1 - start > maxPayloadBytes) {
      return null;
    }
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
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return null;
}

/** Consumes one optional line break after a repaired serialized tool-call fragment. */
export function skipSerializedToolCallTrailingLineBreak(text: string, cursor: number): number {
  const afterLineBreak = consumeLineBreak(text, cursor);
  return afterLineBreak ?? cursor;
}

/** Accepts the legacy closing markers models append after JSON tool-call payloads. */
export function consumeJsonToolClosingMarker(text: string, cursor: number): number {
  let markerStart = cursor;
  while (markerStart < text.length && /\s/.test(text[markerStart] ?? "")) {
    markerStart += 1;
  }
  const rest = text.slice(markerStart);
  if (rest.startsWith(END_TOOL_REQUEST)) {
    return skipSerializedToolCallTrailingLineBreak(text, markerStart + END_TOOL_REQUEST.length);
  }
  const bracketClose = /^\[\/[A-Za-z0-9_-]+\]/.exec(rest);
  if (bracketClose) {
    return skipSerializedToolCallTrailingLineBreak(text, markerStart + bracketClose[0].length);
  }
  if (rest.startsWith(HARMONY_CALL_MARKER)) {
    return skipSerializedToolCallTrailingLineBreak(text, markerStart + HARMONY_CALL_MARKER.length);
  }
  return skipSerializedToolCallTrailingLineBreak(text, cursor);
}

/** Finds JSON after bracketed tool syntax such as `[tool_name]\n{...}`. */
export function findBracketedJsonPayloadStart(text: string): number | null {
  if (!text.startsWith("[")) {
    return null;
  }
  const close = text.indexOf("]");
  if (close === -1) {
    return null;
  }
  let cursor = close + 1;
  cursor = skipHorizontalWhitespace(text, cursor);
  cursor = skipSerializedToolCallTrailingLineBreak(text, cursor);
  cursor = skipHorizontalWhitespace(text, cursor);
  return text[cursor] === "{" ? cursor : null;
}

/** Finds JSON after Harmony channel/tool headers while tolerating optional message markers. */
export function findHarmonyJsonPayloadStart(text: string): number | null {
  let cursor = 0;
  if (text.startsWith(HARMONY_CHANNEL_MARKER)) {
    cursor = HARMONY_CHANNEL_MARKER.length;
  }
  const rest = text.slice(cursor);
  const channel = ["commentary", "analysis", "final"].find((candidate) =>
    rest.startsWith(candidate),
  );
  if (!channel) {
    return null;
  }
  cursor += channel.length;
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.slice(cursor).startsWith("to=")) {
    return null;
  }
  cursor += "to=".length;
  const nameStart = cursor;
  while (isPlainTextToolNameChar(text[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart) {
    return null;
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.slice(cursor).startsWith("code")) {
    return null;
  }
  cursor += "code".length;
  cursor = skipWhitespace(text, cursor);
  if (text.slice(cursor).startsWith(HARMONY_MESSAGE_MARKER)) {
    cursor = skipWhitespace(text, cursor + HARMONY_MESSAGE_MARKER.length);
  }
  return text[cursor] === "{" ? cursor : null;
}

/** Case-insensitive marker compare for ASCII protocol tags without locale rules. */
export function startsWithAsciiMarkerIgnoreCase(
  text: string,
  cursor: number,
  marker: string,
): boolean {
  return text.slice(cursor, cursor + marker.length).toLowerCase() === marker;
}

/** Case-insensitive marker search for ASCII protocol tags without allocating regexes. */
export function indexOfAsciiMarkerIgnoreCase(text: string, marker: string, start: number): number {
  let cursor = start;
  while (cursor < text.length) {
    const next = text.indexOf(marker[0] ?? "", cursor);
    if (next === -1) {
      return -1;
    }
    if (startsWithAsciiMarkerIgnoreCase(text, next, marker)) {
      return next;
    }
    cursor = next + 1;
  }
  return -1;
}

/** Returns the end offset for a complete XML-ish or bracketed plain-text tool call. */
export function findXmlishToolCallEnd(text: string): number | null {
  const invokeEnd = findXmlishInvokeToolCallEnd(text);
  if (invokeEnd !== null) {
    return invokeEnd;
  }

  let cursor: number;
  const xmlFunction = /^<function=[A-Za-z0-9_.:-]+>/i.exec(text);
  if (xmlFunction) {
    cursor = xmlFunction[0].length;
  } else {
    const bracketed = /^\[(?:tool:)?[A-Za-z0-9_-]+\]/.exec(text);
    if (!bracketed) {
      return null;
    }
    cursor = bracketed[0].length;
    cursor = skipHorizontalWhitespace(text, cursor);
    cursor = skipSerializedToolCallTrailingLineBreak(text, cursor);
  }

  cursor = skipWhitespace(text, cursor);
  if (!startsWithAsciiMarkerIgnoreCase(text, cursor, "<parameter=")) {
    return null;
  }

  while (cursor < text.length) {
    const parameterClose = indexOfAsciiMarkerIgnoreCase(text, "</parameter>", cursor);
    if (parameterClose === -1) {
      return null;
    }
    cursor = skipWhitespace(text, parameterClose + "</parameter>".length);
    if (startsWithAsciiMarkerIgnoreCase(text, cursor, "</function>")) {
      return skipSerializedToolCallTrailingLineBreak(text, cursor + "</function>".length);
    }
    if (!startsWithAsciiMarkerIgnoreCase(text, cursor, "<parameter=")) {
      return skipSerializedToolCallTrailingLineBreak(text, cursor);
    }
  }
  return null;
}

/** Consumes one attribute/namespaced `<parameter ...>...</parameter>` child. */
function consumeXmlishAttributeParameterEnd(text: string, start: number): number | null {
  const openMatch = XMLISH_PARAMETER_OPEN_RE.exec(text.slice(start));
  if (!openMatch) {
    return null;
  }
  const payloadStart = start + openMatch[0].length;
  const closeMatch = XMLISH_PARAMETER_CLOSE_RE.exec(text.slice(payloadStart));
  if (!closeMatch) {
    return null;
  }
  return payloadStart + closeMatch.index + closeMatch[0].length;
}

/** Returns the end offset for one complete attribute-dialect invoke tool call. */
function findXmlishInvokeToolCallEnd(text: string): number | null {
  let cursor = 0;
  const wrapperOpen = XMLISH_FUNCTION_CALLS_OPEN_RE.exec(text);
  if (wrapperOpen) {
    cursor = skipWhitespace(text, wrapperOpen[0].length);
  }
  const invokeOpen = XMLISH_INVOKE_OPEN_RE.exec(text.slice(cursor));
  if (!invokeOpen) {
    return null;
  }
  cursor = skipWhitespace(text, cursor + invokeOpen[0].length);

  let parameterCount = 0;
  while (true) {
    const parameterEnd = consumeXmlishAttributeParameterEnd(text, cursor);
    if (parameterEnd === null) {
      break;
    }
    parameterCount += 1;
    cursor = skipWhitespace(text, parameterEnd);
  }
  // Self-closing/no-parameter invoke blocks are intentionally not treated as a
  // complete tool call so they are never promoted from text.
  if (parameterCount === 0) {
    return null;
  }

  const invokeClose = XMLISH_INVOKE_CLOSE_RE.exec(text.slice(cursor));
  if (!invokeClose) {
    return null;
  }
  cursor += invokeClose[0].length;
  // The wrapper close only follows the final invoke; leave it for the next
  // prefix when more invoke blocks share one `<function_calls>` wrapper.
  const afterInvoke = skipWhitespace(text, cursor);
  const wrapperClose = XMLISH_FUNCTION_CALLS_CLOSE_RE.exec(text.slice(afterInvoke));
  if (wrapperClose) {
    cursor = afterInvoke + wrapperClose[0].length;
  }
  return skipSerializedToolCallTrailingLineBreak(text, cursor);
}
