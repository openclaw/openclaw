/**
 * Shared grammar for explicit redaction provenance in persisted text (#142821).
 *
 * A mask (`***`, or `first6…last4` from logging redaction) is ordinary-looking text:
 * once it is stored, no reader can tell "the producer redacted this secret" from
 * "the user typed these exact bytes". Persistence therefore wraps every mask it
 * produces in these markers, and replay may only rewrite marked spans. Unmarked
 * text is literal history and must be left alone — guessing from string shape
 * rewrites prose ellipses, markdown rules, and assignment prefixes.
 *
 * The encoding is unambiguous against literal text (#142821 review):
 * - A mark opens with `REDACTION_PROVENANCE_ESCAPE`, a non-printable control byte that
 *   persistence never stores bare: `escapeRedactionProvenanceLiterals` escapes every
 *   byte it did not emit as part of a mark, and replay restores those bytes. The byte is
 *   not whitespace (so redaction patterns keep the mark as one contiguous token) and is
 *   not trimmed or otherwise rewritten by serialization.
 * - A mark carries its own version (`:1`), so a later encoding is a different token
 *   instead of a reinterpretation of the same bytes.
 * - A mark only counts when its delimiter pair is complete and its body is mask-shaped
 *   (`***`, or one `<prefix>…<suffix>` hint) — the only bodies this encoder emits.
 *   Delimiter text with any other body is literal.
 * Records persisted before this encoding (bare masks, or the pre-versioning
 * delimiters) carry no escape byte at all, so replay never reinterprets them. A tool
 * that stripped the byte would leave a mark literal, which is the same safe direction
 * as unmarked history: it is never rewritten as provenance.
 */

/** Discriminator and escape byte for the grammar. Non-printable; never stored bare. */
export const REDACTION_PROVENANCE_ESCAPE = "\u001F";
/** Versioned delimiter bodies. The escape byte in front of them is the discriminator. */
const REDACTION_PROVENANCE_OPEN_BODY = "⟦openclaw:redacted:1⟧";
const REDACTION_PROVENANCE_CLOSE_BODY = "⟦/openclaw:redacted:1⟧";
/** Opens a persisted mask. */
export const REDACTION_PROVENANCE_START = `${REDACTION_PROVENANCE_ESCAPE}${REDACTION_PROVENANCE_OPEN_BODY}`;
/** Closes a persisted mask. */
export const REDACTION_PROVENANCE_END = `${REDACTION_PROVENANCE_ESCAPE}${REDACTION_PROVENANCE_CLOSE_BODY}`;

/** Mask-shaped mark body: the placeholder, or one `prefix…suffix` diagnostic hint. */
// oxlint-disable-next-line eslint/no-control-regex -- Intentional 0x1F discriminator for provenance marks.
const REDACTION_PROVENANCE_BODY_RE = /^(?:\*{3}|[^\u001F\u27E6\u27E7]+…[^\u001F\u27E6\u27E7]+)$/u;
/** Bytes the grammar reserves; a mask hint that would contain them degrades to `***`. */
// oxlint-disable-next-line eslint/no-control-regex -- Intentional 0x1F discriminator for provenance marks.
const REDACTION_PROVENANCE_SYNTAX_RE = /[\u001F\u27E6\u27E7]/u;
/** An opener that a reader would honor: the escape byte is not itself escaped. */
// oxlint-disable-next-line eslint/no-control-regex -- Intentional 0x1F discriminator for provenance marks.
const REDACTION_PROVENANCE_OPENER_RE = /(?<!\u001F)\u001F⟦openclaw:redacted:1⟧/u;

/** Returns whether text carries at least one provenance opener. */
export function hasRedactionProvenance(text: string): boolean {
  return REDACTION_PROVENANCE_OPENER_RE.test(text);
}

/** Returns whether text contains any byte the grammar reserves. */
export function containsRedactionProvenanceSyntax(text: string): boolean {
  return REDACTION_PROVENANCE_SYNTAX_RE.test(text);
}

/** Returns whether the value is exactly one complete, mask-shaped marked span. */
export function isRedactionProvenanceMask(value: string): boolean {
  if (!value.startsWith(REDACTION_PROVENANCE_START) || !value.endsWith(REDACTION_PROVENANCE_END)) {
    return false;
  }
  const body = value.slice(
    REDACTION_PROVENANCE_START.length,
    value.length - REDACTION_PROVENANCE_END.length,
  );
  return REDACTION_PROVENANCE_BODY_RE.test(body);
}

/** Wraps one freshly produced mask. Input that is already such a mask passes through. */
export function markRedactionProvenance(mask: string): string {
  if (isRedactionProvenanceMask(mask)) {
    return mask;
  }
  return `${REDACTION_PROVENANCE_START}${mask}${REDACTION_PROVENANCE_END}`;
}

type RedactionProvenanceVisitor = {
  /** Rewrites one literal run. */
  literal: (text: string) => string;
  /** Rewrites one complete mask-shaped marked span, passed its mask body. */
  marked: (mask: string) => string;
};

/**
 * Visits literal runs and marked spans of one string in a single pass.
 * A doubled escape byte is an escaped literal byte, an unterminated mark and a mark
 * whose body is not mask-shaped are both literal, and a mark never nests.
 */
function scanRedactionProvenance(text: string, visit: RedactionProvenanceVisitor): string {
  if (!text.includes(REDACTION_PROVENANCE_ESCAPE)) {
    return visit.literal(text);
  }
  const parts: string[] = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== REDACTION_PROVENANCE_ESCAPE) {
      index += 1;
      continue;
    }
    // A doubled escape byte is literal text and cannot open a mark.
    if (text.startsWith(REDACTION_PROVENANCE_ESCAPE, index + 1)) {
      index += 2;
      continue;
    }
    if (!text.startsWith(REDACTION_PROVENANCE_OPEN_BODY, index + 1)) {
      index += 1;
      continue;
    }
    const markStart = index + REDACTION_PROVENANCE_START.length;
    const close = text.indexOf(REDACTION_PROVENANCE_END, markStart);
    if (close < 0) {
      index += 1;
      continue;
    }
    const mask = text.slice(markStart, close);
    if (!REDACTION_PROVENANCE_BODY_RE.test(mask)) {
      index += 1;
      continue;
    }
    parts.push(visit.literal(text.slice(cursor, index)), visit.marked(mask));
    index = close + REDACTION_PROVENANCE_END.length;
    cursor = index;
  }
  return parts.length === 0
    ? visit.literal(text)
    : parts.join("") + visit.literal(text.slice(cursor));
}

/** Restores escaped literal bytes. Pairs collapse once, so raw bytes round-trip. */
function unescapeRedactionProvenanceLiterals(text: string): string {
  const escape = REDACTION_PROVENANCE_ESCAPE;
  if (!text.includes(escape)) {
    return text;
  }
  return text.split(`${escape}${escape}`).join(escape);
}

/** Normalizes one literal run so every escape byte it carries is escaped exactly once. */
function escapeLoneRedactionProvenanceEscapes(text: string): string {
  const escape = REDACTION_PROVENANCE_ESCAPE;
  let separator = text.indexOf(escape);
  if (separator < 0) {
    return text;
  }
  let result = "";
  let cursor = 0;
  while (separator >= 0) {
    result += text.slice(cursor, separator);
    cursor = separator + escape.length;
    if (text.startsWith(escape, cursor)) {
      // Already an escaped pair: it stays one escaped pair.
      cursor += escape.length;
    }
    result += `${escape}${escape}`;
    separator = text.indexOf(escape, cursor);
  }
  return result + text.slice(cursor);
}

/**
 * Escapes the literal bytes of text that could otherwise be read as the grammar, and
 * leaves the marks this encoder emits exactly as they are. Already escaped text is a
 * fixed point, so repeated persistence passes cannot re-encode it.
 */
export function escapeRedactionProvenanceLiterals(text: string): string {
  if (!text.includes(REDACTION_PROVENANCE_ESCAPE)) {
    return text;
  }
  return scanRedactionProvenance(text, {
    literal: escapeLoneRedactionProvenanceEscapes,
    marked: (mask) => `${REDACTION_PROVENANCE_START}${mask}${REDACTION_PROVENANCE_END}`,
  });
}

/**
 * Replaces every complete marked span with `replacement`, keeping all surrounding
 * text byte-identical after restoring its escaped bytes. An unterminated opener is
 * left verbatim: a reader that cannot see the end of a mask must not invent one.
 */
export function replaceRedactionProvenance(text: string, replacement: string): string {
  if (!hasRedactionProvenance(text)) {
    return unescapeRedactionProvenanceLiterals(text);
  }
  return scanRedactionProvenance(text, {
    literal: unescapeRedactionProvenanceLiterals,
    marked: () => replacement,
  });
}

/**
 * Canonical form of one persisted string for byte-level identity comparison: every
 * marked span collapses to its mask body and escaped literal bytes are restored, so a
 * pre-upgrade row with bare masks and a freshly encoded row with the same content
 * compare equal. Genuinely different payloads still differ.
 */
export function stripRedactionProvenance(text: string): string {
  if (!text.includes(REDACTION_PROVENANCE_ESCAPE)) {
    return text;
  }
  return scanRedactionProvenance(text, {
    literal: unescapeRedactionProvenanceLiterals,
    marked: (mask) => mask,
  });
}
