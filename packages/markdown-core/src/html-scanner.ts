// Rendering and visibility retain their malformed-input policies over one tag scanner.
type HtmlTagMode = "render" | "visibility";
export const RAW_TEXT_TAGS = new Set(["script", "style", "noscript"]);

type HtmlTagToken = {
  closing: boolean;
  name: string;
  raw: string;
  attrs: string;
  selfClosing: boolean;
};

type ReadTagResult = {
  token: HtmlTagToken | null;
  next: number;
};

type TagEndResult = {
  end: number;
  rawTextStart?: number;
};

export function isAsciiWhitespace(value: string): boolean {
  return value === " " || value === "\n" || value === "\r" || value === "\t" || value === "\f";
}

export function isTagNameChar(value: string): boolean {
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    value === "." ||
    value === "-" ||
    value === "_" ||
    value === ":"
  );
}

function isTagNameStartChar(value: string): boolean {
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagBoundary(value: string | undefined): boolean {
  return !value || isAsciiWhitespace(value) || value === ">" || value === "/";
}

function asciiLower(value: string): string {
  const code = value.charCodeAt(0);
  return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value;
}

function startsWithClosingTag(html: string, start: number, tagName: string): boolean {
  if (html[start] !== "<" || html[start + 1] !== "/") {
    return false;
  }
  for (let offset = 0; offset < tagName.length; offset += 1) {
    if (asciiLower(html[start + 2 + offset] ?? "") !== tagName[offset]) {
      return false;
    }
  }
  return isTagBoundary(html[start + 2 + tagName.length]);
}

export function readRawTextOpenTagName(html: string, start: number): string | undefined {
  if (html[start] !== "<" || html[start + 1] === "/") {
    return undefined;
  }
  for (const tagName of RAW_TEXT_TAGS) {
    let matches = true;
    for (let offset = 0; offset < tagName.length; offset += 1) {
      if (asciiLower(html[start + 1 + offset] ?? "") !== tagName[offset]) {
        matches = false;
        break;
      }
    }
    if (matches && isTagBoundary(html[start + 1 + tagName.length])) {
      return tagName;
    }
  }
  return undefined;
}

export function findRawTextOpenTagStart(html: string, start: number, end: number): number {
  const span = html.slice(start, end);
  for (let offset = span.indexOf("<"); offset !== -1; offset = span.indexOf("<", offset + 1)) {
    const i = start + offset;
    if (readRawTextOpenTagName(html, i)) {
      return i;
    }
  }
  return -1;
}

export function startsLikeHtmlTag(html: string, start: number): boolean {
  const next = html[start + 1];
  return next === "!" || next === "?" || next === "/" || isTagNameStartChar(next ?? "");
}

function findTagEnd(html: string, start: number, mode: HtmlTagMode = "render"): TagEndResult {
  const rendering = mode === "render";
  let afterEquals = false;
  let rawTextStartInQuote: number | undefined;
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html.charAt(i);
    if (afterEquals && isAsciiWhitespace(ch)) {
      continue;
    }
    if ((!rendering || afterEquals) && (ch === '"' || ch === "'")) {
      const quoteEnd = html.indexOf(ch, i + 1);
      if (rendering && rawTextStartInQuote === undefined) {
        const rawTextStart = findRawTextOpenTagStart(
          html,
          i + 1,
          quoteEnd === -1 ? html.length : quoteEnd,
        );
        if (rawTextStart !== -1) {
          rawTextStartInQuote = rawTextStart;
        }
      }
      if (quoteEnd === -1) {
        return { end: -1, rawTextStart: rawTextStartInQuote };
      }
      i = quoteEnd;
      afterEquals = false;
      continue;
    }
    afterEquals = false;
    if (rendering && readRawTextOpenTagName(html, i)) {
      return { end: -1, rawTextStart: i };
    }
    if (ch === ">") {
      return { end: i };
    }
    if (ch === "=") {
      afterEquals = true;
    }
  }
  return { end: -1, rawTextStart: rawTextStartInQuote };
}

function isSelfClosingTagRaw(raw: string): boolean {
  const trimmed = raw.trimEnd();
  if (!trimmed.endsWith("/")) {
    return false;
  }
  const beforeSlash = trimmed.charAt(trimmed.length - 2);
  const tagBody = trimmed.slice(0, -1);
  let hasAttributeSeparator = false;
  for (const ch of tagBody) {
    if (isAsciiWhitespace(ch)) {
      hasAttributeSeparator = true;
      break;
    }
  }
  return (
    !beforeSlash ||
    isAsciiWhitespace(beforeSlash) ||
    beforeSlash === '"' ||
    beforeSlash === "'" ||
    !hasAttributeSeparator
  );
}

export function skipHtmlComment(html: string, start: number): number {
  if (html[start + 4] === ">") {
    return start + 5;
  }
  if (html.startsWith("->", start + 4)) {
    return start + 6;
  }
  for (let end = html.indexOf("--", start + 4); end !== -1; end = html.indexOf("--", end + 1)) {
    const bracket = html[end + 2] === "!" ? end + 3 : end + 2;
    if (html[bracket] === ">") {
      return bracket + 1;
    }
  }
  return html.length;
}

export function readTagToken(
  html: string,
  start: number,
  mode: HtmlTagMode = "render",
): ReadTagResult | null {
  const rendering = mode === "render";
  if (rendering && html.startsWith("<!--", start)) {
    return { token: null, next: skipHtmlComment(html, start) };
  }

  const tagEnd = findTagEnd(html, start, mode);
  const end = tagEnd.end;
  if (end === -1) {
    return tagEnd.rawTextStart === undefined ? null : { token: null, next: tagEnd.rawTextStart };
  }

  const raw = html.slice(start + 1, end);
  const body = raw;
  let pos = 0;
  const closing = body[pos] === "/";
  if (closing) {
    pos += 1;
  }
  if (!isTagNameStartChar(body[pos] ?? "")) {
    return { token: null, next: end + 1 };
  }

  const nameStart = pos;
  while (
    pos < body.length &&
    !isAsciiWhitespace(body.charAt(pos)) &&
    body[pos] !== "/" &&
    body[pos] !== ">"
  ) {
    pos += 1;
  }

  const attrs = closing ? "" : body.slice(pos);
  return {
    token: {
      closing,
      name: body
        .slice(nameStart, pos)
        .replace(/\0|[A-Z]/g, (ch) => (ch === "\0" ? "\uFFFD" : asciiLower(ch))),
      raw,
      attrs,
      selfClosing: rendering ? isSelfClosingTagRaw(raw) : !closing && attrs.trimEnd().endsWith("/"),
    },
    next: end + 1,
  };
}

export function readRawTextBounds(
  html: string,
  tagName: string,
  contentStart: number,
  mode: HtmlTagMode = "render",
): { contentEnd: number; end: number } {
  if (tagName === "script") {
    // In double-escaped script data, </script> is text that returns to the escaped state.
    let state: "data" | "escaped" | "double-escaped" = "data";
    for (let cursor = contentStart; cursor < html.length; cursor += 1) {
      if (state === "data" && html.startsWith("<!--", cursor)) {
        state = "escaped";
        // Revisit the dashes so <!--> also returns to normal script data.
        cursor += 1;
        continue;
      }
      if (state !== "data" && html.startsWith("-->", cursor)) {
        state = "data";
        cursor += 2;
        continue;
      }
      if (html[cursor] !== "<") {
        continue;
      }
      if (startsWithClosingTag(html, cursor, tagName)) {
        if (state === "double-escaped") {
          state = "escaped";
          cursor += tagName.length + 1;
          continue;
        }
        const closeEnd = findTagEnd(html, cursor, mode).end;
        return { contentEnd: cursor, end: closeEnd === -1 ? html.length : closeEnd + 1 };
      }
      if (state === "escaped" && readRawTextOpenTagName(html, cursor) === "script") {
        state = "double-escaped";
        cursor += tagName.length;
      }
    }
    return { contentEnd: html.length, end: html.length };
  }
  let closeStart = html.indexOf("</", contentStart);
  while (closeStart !== -1) {
    if (startsWithClosingTag(html, closeStart, tagName)) {
      const closeEnd = findTagEnd(html, closeStart, mode).end;
      return { contentEnd: closeStart, end: closeEnd === -1 ? html.length : closeEnd + 1 };
    }
    closeStart = html.indexOf("</", closeStart + 2);
  }
  return { contentEnd: html.length, end: html.length };
}

export function skipRawTextElement(html: string, start: number, tagName: string): number {
  const openerEnd = findTagEnd(html, start);
  const contentStart = openerEnd.end === -1 ? start + tagName.length + 1 : openerEnd.end + 1;
  return readRawTextBounds(html, tagName, contentStart).end;
}
