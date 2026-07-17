export const HTTP_AUTH_SCHEME_PATTERN = "[A-Za-z0-9!#$%&'*+.^_`|~-]+";
// Each JSON encoding doubles delimiter slashes and adds one. The cap covers six nested
// encodings while keeping credential redaction regex work bounded on hostile diagnostics.
export const HTTP_AUTH_SERIALIZED_QUOTE_PATTERN = String.raw`(?:\\{1,64}["']|["']|)`;
const STRUCTURED_AUTH_HEADER_RE = new RegExp(
  String.raw`(^|[^A-Za-z0-9_-])(?:Proxy-)?Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}\s*[:=]\s*${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(${HTTP_AUTH_SCHEME_PATTERN})\s+`,
  "giu",
);
const AUTH_PARAM_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+/u;
const AUTH_PARAM_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+/u;
const AWS_SCOPE_VALUE_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~:/-]+/u;

export type StructuredAuthParamRange = { start: number; end: number };

function skipHorizontalWhitespace(value: string, start: number): number {
  let cursor = start;
  while (value[cursor] === " " || value[cursor] === "\t") {
    cursor += 1;
  }
  return cursor;
}

function readAuthParamName(value: string, start: number): { name: string; end: number } | null {
  const match = AUTH_PARAM_NAME_RE.exec(value.slice(start));
  return match ? { name: match[0].toLowerCase(), end: start + match[0].length } : null;
}

function readParamValue(
  value: string,
  start: number,
  options: { awsScope: boolean; signedHeaders: boolean },
): number | null {
  let escapedQuoteSlashCount = 0;
  while (value[start + escapedQuoteSlashCount] === "\\") {
    escapedQuoteSlashCount += 1;
  }
  const escapedQuotes = escapedQuoteSlashCount > 0 && value[start + escapedQuoteSlashCount] === '"';
  if (value[start] === '"' || escapedQuotes) {
    let cursor = start + (escapedQuotes ? escapedQuoteSlashCount + 1 : 1);
    while (cursor < value.length && value[cursor] !== "\r" && value[cursor] !== "\n") {
      if (escapedQuotes && value[cursor] === "\\") {
        let slashEnd = cursor + 1;
        while (value[slashEnd] === "\\") {
          slashEnd += 1;
        }
        if (value[slashEnd] === '"') {
          const slashCount = slashEnd - cursor;
          if (slashCount % (2 * (escapedQuoteSlashCount + 1)) === escapedQuoteSlashCount) {
            return slashEnd + 1;
          }
          cursor = slashEnd + 1;
          continue;
        }
        cursor = slashEnd;
        continue;
      }
      if (!escapedQuotes && value[cursor] === "\\" && cursor + 1 < value.length) {
        cursor += 2;
        continue;
      }
      if (!escapedQuotes && value[cursor] === '"') {
        return cursor + 1;
      }
      cursor += 1;
    }
    return cursor > start + 1 ? cursor : null;
  }

  if (options.signedHeaders) {
    const match = /^:?[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:;:?[A-Za-z0-9!#$%&'*+.^_`|~-]+)*/u.exec(
      value.slice(start),
    );
    if (!match) {
      return null;
    }
    const end = start + match[0].length;
    const next = value[end];
    return next === undefined ||
      next === "," ||
      next === " " ||
      next === "\t" ||
      next === "\r" ||
      next === "\n"
      ? end
      : null;
  }
  const match = (options.awsScope ? AWS_SCOPE_VALUE_RE : AUTH_PARAM_TOKEN_RE).exec(
    value.slice(start),
  );
  return match ? start + match[0].length : null;
}

export function findStructuredAuthParamRanges(value: string): StructuredAuthParamRange[] {
  const ranges: StructuredAuthParamRange[] = [];
  for (const header of value.matchAll(STRUCTURED_AUTH_HEADER_RE)) {
    const scheme = (header[2] ?? "").toLowerCase();
    let cursor = (header.index ?? 0) + header[0].length;
    const rangeStart = cursor;
    let rangeEnd = cursor;

    // Commas belong to the credential grammar. Only an explicit field boundary, line end,
    // or malformed next auth-param can end the value without risking a credential leak.
    for (;;) {
      const param = readAuthParamName(value, cursor);
      if (!param) {
        break;
      }
      cursor = skipHorizontalWhitespace(value, param.end);
      if (value[cursor] !== "=") {
        break;
      }
      cursor = skipHorizontalWhitespace(value, cursor + 1);
      const valueEnd = readParamValue(value, cursor, {
        awsScope: scheme.startsWith("aws4-") && param.name === "credential",
        signedHeaders: param.name === "signedheaders",
      });
      if (valueEnd === null) {
        break;
      }
      rangeEnd = valueEnd;

      const separator = skipHorizontalWhitespace(value, valueEnd);
      if (value[separator] !== ",") {
        break;
      }
      const nextParamStart = skipHorizontalWhitespace(value, separator + 1);
      const nextParam = readAuthParamName(value, nextParamStart);
      if (!nextParam) {
        break;
      }
      const equals = skipHorizontalWhitespace(value, nextParam.end);
      if (value[equals] !== "=") {
        break;
      }
      cursor = nextParamStart;
    }

    if (rangeEnd > rangeStart) {
      ranges.push({ start: rangeStart, end: rangeEnd });
    }
  }
  return ranges;
}

export function redactStructuredAuthHeaders(value: string, replacement: string): string {
  const ranges = findStructuredAuthParamRanges(value);
  if (ranges.length === 0) {
    return value;
  }
  const merged: StructuredAuthParamRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const range of merged) {
    parts.push(value.slice(cursor, range.start), replacement);
    cursor = range.end;
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}
