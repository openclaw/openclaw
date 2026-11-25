import type { PlainTextToolCallNameMatcher } from "./contracts.js";
import {
  consumeLineBreak,
  END_TOOL_REQUEST,
  HARMONY_CALL_MARKER,
  indexOfAsciiMarkerIgnoreCase,
  isAsciiMarkerPrefixIgnoreCase,
  isXmlishNameChar,
  type JsonObjectScanState,
  scanJsonObject,
  skipLineIndentation,
  skipWhitespace,
  startsWithAsciiMarkerIgnoreCase,
  type StructuralLineBreakOptions,
  utf8ByteLengthWithinLimit,
} from "./grammar.js";
import { scanPlainTextToolCall } from "./payload.js";

export const MAX_PAYLOAD_BYTES = 256_000;
const MAX_TOOL_NAME_CHARS = 120;

type XmlSuppressor = { carry: string; kind: "xml"; phase: "body" | "parameter" };

type JsonSuppressor = JsonObjectScanState & {
  carry: string;
  kind: "json";
  optionalClosings?: readonly string[];
  phase: "closing" | "opening" | "payload";
  requiredClosing?: string;
};

type OpeningSuppressor = {
  allowXml: boolean;
  carry: string;
  choice?: JsonSuppressor | XmlSuppressor;
  json: JsonSuppressor;
  kind: "opening";
};

export type OverCapSuppressor = JsonSuppressor | OpeningSuppressor | XmlSuppressor;

export function consumeRemovedLineEnd(text: string, end: number): number {
  const lineBreakStart = skipLineIndentation(text, end);
  if (lineBreakStart === text.length) {
    return lineBreakStart;
  }
  return consumeLineBreak(text, lineBreakStart) ?? end;
}

const XML_PARAMETER_CLOSE = "</parameter>";
const XML_FUNCTION_CLOSE = "</function>";
const XML_PARAMETER_OPEN = "<parameter=";

export function createOverCapSuppressor(
  view: { text: string; structuralLineBreaks?: StructuralLineBreakOptions },
  matcher: PlainTextToolCallNameMatcher,
  force = false,
): OverCapSuppressor | undefined {
  const start = skipLineIndentation(view.text, 0);
  const scan = scanPlainTextToolCall(view.text, start, {
    matcher,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    structuralLineBreaks: view.structuralLineBreaks,
  });
  const { json, matches, xmlish } = scan;
  const value =
    json.kind === "prefix" ? json.candidate : json.kind === "complete" ? json : undefined;
  const state =
    value?.json ??
    (json.kind === "complete" ? { depth: 0, escaped: false, inString: false } : undefined);
  const name = value ? view.text.slice(value.name.start, value.name.end) : "";
  const jsonSuppressor: JsonSuppressor | undefined = value
    ? {
        kind: "json",
        carry:
          value.payload && state?.depth === 0
            ? view.text.slice(skipWhitespace(view.text, value.payload.end))
            : "",
        depth: state?.depth ?? 0,
        escaped: state?.escaped ?? false,
        inString: state?.inString ?? false,
        phase: !value.payload ? "opening" : state?.depth === 0 ? "closing" : "payload",
        ...(value.syntax === "named-bracket"
          ? { requiredClosing: `[/${name}]` }
          : { optionalClosings: [HARMONY_CALL_MARKER, END_TOOL_REQUEST, `[/${name}]`] }),
      }
    : undefined;
  if (force && jsonSuppressor && value?.nameComplete === true && !value.payload && matches.json) {
    return {
      allowXml: xmlish.kind === "prefix" && matches.xmlish,
      carry: "",
      json: jsonSuppressor,
      kind: "opening",
    };
  }
  if (
    xmlish.kind === "prefix" &&
    matches.xmlish &&
    xmlish.candidate?.payload &&
    (force ||
      utf8ByteLengthWithinLimit(
        view.text,
        xmlish.candidate.payload.start,
        xmlish.candidate.payload.end,
        MAX_PAYLOAD_BYTES,
      ) === null)
  ) {
    const phase = xmlish.candidate.activeParameterOpenEnd === undefined ? "body" : "parameter";
    const markers =
      phase === "parameter" ? [XML_PARAMETER_CLOSE] : [XML_PARAMETER_OPEN, XML_FUNCTION_CLOSE];
    const markerStart = view.text.lastIndexOf("<");
    const carry =
      markerStart !== -1 &&
      markers.some((marker) => isAsciiMarkerPrefixIgnoreCase(view.text, markerStart, marker))
        ? view.text.slice(markerStart)
        : "";
    return {
      kind: "xml",
      carry,
      phase,
    };
  }
  if (
    !value ||
    !jsonSuppressor ||
    (!value.nameComplete && !value.payload) ||
    !matches.json ||
    (!state && !force) ||
    (!value.payload && !force) ||
    (!force &&
      value.payload &&
      utf8ByteLengthWithinLimit(
        view.text,
        value.payload.start,
        value.payload.end,
        MAX_PAYLOAD_BYTES,
      ) !== null)
  ) {
    return undefined;
  }
  return jsonSuppressor;
}

function consumeXmlSuppressor(
  suppressor: XmlSuppressor,
  chunk: string,
): { complete: false } | { complete: true; suffix: string } {
  const text = suppressor.carry + chunk;
  suppressor.carry = "";
  let cursor = 0;
  while (true) {
    if (suppressor.phase === "parameter") {
      const close = indexOfAsciiMarkerIgnoreCase(text, XML_PARAMETER_CLOSE, cursor);
      if (close === -1) {
        suppressor.carry = text.slice(-(XML_PARAMETER_CLOSE.length - 1));
        return { complete: false };
      }
      cursor = close + XML_PARAMETER_CLOSE.length;
      suppressor.phase = "body";
    }
    const markerStart = skipWhitespace(text, cursor);
    if (markerStart === text.length) {
      return { complete: false };
    }
    if (startsWithAsciiMarkerIgnoreCase(text, markerStart, XML_FUNCTION_CLOSE)) {
      const end = consumeRemovedLineEnd(text, markerStart + XML_FUNCTION_CLOSE.length);
      return { complete: true, suffix: text.slice(end) };
    }
    const markerPrefix =
      isAsciiMarkerPrefixIgnoreCase(text, markerStart, XML_FUNCTION_CLOSE) ||
      isAsciiMarkerPrefixIgnoreCase(text, markerStart, XML_PARAMETER_OPEN);
    if (markerPrefix) {
      suppressor.carry = text.slice(markerStart);
      return { complete: false };
    }
    if (startsWithAsciiMarkerIgnoreCase(text, markerStart, XML_PARAMETER_OPEN)) {
      const restLength = text.length - markerStart;
      const close = text.indexOf(">", markerStart + XML_PARAMETER_OPEN.length);
      if (close === -1 && restLength <= XML_PARAMETER_OPEN.length + 120) {
        suppressor.carry = text.slice(markerStart);
        return { complete: false };
      }
      if (close === -1) {
        return { complete: true, suffix: text.slice(markerStart) };
      }
      const name = text.slice(markerStart + XML_PARAMETER_OPEN.length, close);
      if (
        !name ||
        name.length > MAX_TOOL_NAME_CHARS ||
        Array.from(name).some((character) => !isXmlishNameChar(character))
      ) {
        return { complete: true, suffix: text.slice(markerStart) };
      }
      suppressor.phase = "parameter";
      cursor = close + 1;
      continue;
    }
    return { complete: true, suffix: text.slice(markerStart) };
  }
}

function consumeJsonSuppressor(
  suppressor: JsonSuppressor,
  chunk: string,
): { complete: false } | { complete: true; suffix: string } {
  let text = suppressor.carry + chunk;
  suppressor.carry = "";
  let cursor = 0;
  if (suppressor.phase === "opening") {
    cursor = skipWhitespace(text, cursor);
    if (cursor === text.length) {
      return { complete: false };
    }
    if (text[cursor] !== "{") {
      return { complete: true, suffix: text.slice(cursor) };
    }
    suppressor.depth = 1;
    suppressor.phase = "payload";
    cursor += 1;
  }
  if (suppressor.phase === "payload") {
    const scanned = scanJsonObject(text, cursor, suppressor);
    if (scanned.kind === "prefix") {
      return { complete: false };
    }
    suppressor.phase = "closing";
    text = text.slice(scanned.end);
  }

  const markerStart = skipWhitespace(text, 0);
  const rest = text.slice(markerStart);
  const closings = suppressor.requiredClosing
    ? [suppressor.requiredClosing, END_TOOL_REQUEST]
    : (suppressor.optionalClosings ?? []);
  const closing = closings.find((marker) => rest.startsWith(marker));
  if (closing) {
    const end = consumeRemovedLineEnd(rest, closing.length);
    return { complete: true, suffix: rest.slice(end) };
  }
  if (closings.some((marker) => marker.startsWith(rest))) {
    // Keep bounded leading whitespace with a split optional closer. If the next
    // chunk disproves the closer, it remains part of the visible suffix.
    suppressor.carry = suppressor.requiredClosing
      ? rest
      : text.slice(-Math.max(...closings.map((marker) => marker.length)));
    return { complete: false };
  }
  const end = suppressor.requiredClosing ? markerStart : consumeRemovedLineEnd(text, 0);
  return { complete: true, suffix: text.slice(end) };
}

function consumeOpeningSuppressor(
  suppressor: OpeningSuppressor,
  chunk: string,
): { complete: false } | { complete: true; suffix: string } {
  if (suppressor.choice) {
    return consumeOverCapSuppressor(suppressor.choice, chunk);
  }
  const text = suppressor.carry + chunk;
  suppressor.carry = "";
  const start = skipWhitespace(text, 0);
  if (start === text.length) {
    return { complete: false };
  }
  const rest = text.slice(start);
  if (rest[0] === "{") {
    suppressor.choice = suppressor.json;
    return consumeJsonSuppressor(suppressor.choice, rest);
  }
  if (suppressor.allowXml) {
    if (isAsciiMarkerPrefixIgnoreCase(rest, 0, XML_PARAMETER_OPEN)) {
      suppressor.carry = rest;
      return { complete: false };
    }
    if (startsWithAsciiMarkerIgnoreCase(rest, 0, XML_PARAMETER_OPEN)) {
      suppressor.choice = { carry: "", kind: "xml", phase: "body" };
      return consumeXmlSuppressor(suppressor.choice, rest);
    }
  }
  return { complete: true, suffix: rest };
}

export function consumeOverCapSuppressor(
  suppressor: OverCapSuppressor,
  chunk: string,
): { complete: false } | { complete: true; suffix: string } {
  return suppressor.kind === "xml"
    ? consumeXmlSuppressor(suppressor, chunk)
    : suppressor.kind === "json"
      ? consumeJsonSuppressor(suppressor, chunk)
      : consumeOpeningSuppressor(suppressor, chunk);
}
