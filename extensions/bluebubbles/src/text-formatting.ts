/**
 * Markdown -> BlueBubbles textFormatting ranges.
 *
 * BlueBubbles Server PR #766 added an optional `textFormatting` field to
 * `/api/v1/message/text` that the macOS 15+ Private API renders as bold /
 * italic / underline / strikethrough runs. This helper translates inline
 * markdown into the wire format that PR expects: an array of
 * `{ start, length, styles[] }` ranges over the *stripped* message body.
 *
 * Stays intentionally minimal:
 *   - Inline marks only: `**bold**`, `__bold__`, `*italic*`, `_italic_`,
 *     `~~strike~~`. Nesting supported (e.g. `**_bold italic_**`).
 *   - Block markdown (headings, blockquotes, code spans, hr, code fences)
 *     is delegated to `stripMarkdown` from the plugin SDK; if the input
 *     contains any of those, we abandon the formatting ranges and fall
 *     back to plain stripping. Avoids subtle index drift between the
 *     ranges and the message body BB validates against. The flag is opt-in
 *     so this conservative path is safe.
 *
 * Backward compatibility: stock BB Server (no PR #766) silently drops the
 * `textFormatting` payload key (validatorjs ignores unknown fields and
 * the validator doesn't destructure it). On macOS <15, PR #766 returns a
 * 400 — callers must gate on macOS version, not just feature config.
 */

export type TextFormattingStyle = "bold" | "italic" | "underline" | "strikethrough";

export type TextFormattingRange = {
  start: number;
  length: number;
  styles: TextFormattingStyle[];
};

export type ExtractedFormatting = {
  plain: string;
  formatting: TextFormattingRange[];
};

const BLOCK_MARKDOWN_PATTERN = /(^\s{0,3}#{1,6}\s)|(^\s{0,3}>\s?)|(^[-*_]{3,}\s*$)|(`)|(```)/m;

type Token = { kind: "text"; value: string } | { kind: "open" | "close"; marker: Marker };

type Marker = {
  /** Wire-format style emitted for this marker. */
  style: TextFormattingStyle;
  /** Marker bytes in source (e.g. `**`, `*`, `~~`). */
  open: string;
  close: string;
  /**
   * If the marker can be matched by either of two source patterns (e.g.
   * `**bold**` or `__bold__` both produce `bold`), list both. The first
   * entry is the canonical form used for matching pairs.
   */
};

const MARKERS: Marker[] = [
  { style: "bold", open: "**", close: "**" },
  { style: "bold", open: "__", close: "__" },
  { style: "strikethrough", open: "~~", close: "~~" },
  { style: "italic", open: "*", close: "*" },
  { style: "italic", open: "_", close: "_" },
];

const WORD_CHAR = /[\p{L}\p{N}]/u;

function tryReadMarker(input: string, i: number): Marker | null {
  for (const m of MARKERS) {
    if (input.startsWith(m.open, i)) {
      // Single-char `*` / `_` markers must not be adjacent to `*` / `_`
      // (those are double-mark openers handled above) or, for `_`, to a
      // word character (matches stripMarkdown's word-boundary heuristic
      // so `snake_case_names` are not mangled).
      if (m.open === "*") {
        const prev = input[i - 1];
        const next = input[i + 1];
        if (prev === "*" || next === "*") continue;
      }
      if (m.open === "_") {
        const prev = input[i - 1];
        const next = input[i + 1];
        if (prev === "_" || next === "_") continue;
        if (prev && WORD_CHAR.test(prev)) continue;
      }
      return m;
    }
  }
  return null;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const stack: Marker[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf.length > 0) {
      tokens.push({ kind: "text", value: buf });
      buf = "";
    }
  };
  while (i < input.length) {
    const top = stack[stack.length - 1];
    // Prefer closing the active marker over re-opening it.
    if (top && input.startsWith(top.close, i)) {
      flush();
      tokens.push({ kind: "close", marker: top });
      stack.pop();
      i += top.close.length;
      continue;
    }
    const m = tryReadMarker(input, i);
    if (m) {
      // Look ahead for a matching close *somewhere* before EOL/EOI; if
      // missing, treat the marker bytes as literal text.
      const closeIdx = input.indexOf(m.close, i + m.open.length);
      if (closeIdx === -1) {
        buf += input[i];
        i += 1;
        continue;
      }
      flush();
      tokens.push({ kind: "open", marker: m });
      stack.push(m);
      i += m.open.length;
      continue;
    }
    buf += input[i];
    i += 1;
  }
  flush();
  // Any unclosed markers fall through as literal text — recover by
  // converting trailing `open` tokens back into text. Simpler than a
  // backtracking parser and matches user intent (unbalanced markup is
  // probably literal in iMessage context).
  return collapseUnclosed(tokens);
}

function collapseUnclosed(tokens: Token[]): Token[] {
  const open = new Map<Marker, number>();
  for (const t of tokens) {
    if (t.kind === "open") open.set(t.marker, (open.get(t.marker) ?? 0) + 1);
    else if (t.kind === "close") {
      const n = open.get(t.marker);
      if (n) open.set(t.marker, n - 1);
    }
  }
  const unclosedMarkers = new Set<Marker>();
  for (const [m, n] of open) if (n > 0) unclosedMarkers.add(m);
  if (unclosedMarkers.size === 0) return tokens;
  const out: Token[] = [];
  for (const t of tokens) {
    if (t.kind === "open" && unclosedMarkers.has(t.marker)) {
      out.push({ kind: "text", value: t.marker.open });
    } else {
      out.push(t);
    }
  }
  return out;
}

export function extractTextFormatting(raw: string): ExtractedFormatting {
  if (!raw) return { plain: "", formatting: [] };
  if (BLOCK_MARKDOWN_PATTERN.test(raw)) {
    return { plain: raw, formatting: [] };
  }
  const tokens = tokenize(raw);
  let plain = "";
  const stack: { marker: Marker; start: number }[] = [];
  const ranges: TextFormattingRange[] = [];
  for (const t of tokens) {
    if (t.kind === "text") {
      plain += t.value;
    } else if (t.kind === "open") {
      stack.push({ marker: t.marker, start: plain.length });
    } else {
      const top = stack.pop();
      if (!top || top.marker !== t.marker) continue;
      const length = plain.length - top.start;
      if (length > 0) {
        ranges.push({ start: top.start, length, styles: [top.marker.style] });
      }
    }
  }
  return { plain, formatting: mergeRanges(ranges) };
}

/**
 * Merge ranges that share `{start, length}` into a single multi-style
 * range. Keeps the wire payload compact and makes nested markers like
 * `**_x_**` produce one range with `["bold","italic"]` instead of two
 * overlapping ones (which the BB Server validator accepts but renders
 * less predictably).
 */
function mergeRanges(ranges: TextFormattingRange[]): TextFormattingRange[] {
  const byKey = new Map<string, TextFormattingRange>();
  for (const r of ranges) {
    const key = `${r.start}:${r.length}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const s of r.styles) if (!existing.styles.includes(s)) existing.styles.push(s);
    } else {
      byKey.set(key, { start: r.start, length: r.length, styles: [...r.styles] });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.start - b.start || a.length - b.length);
}
