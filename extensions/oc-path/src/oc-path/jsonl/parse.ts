/**
 * JSONL parser — splits on `\n`, parses each non-empty line as JSONC
 * (allowing comments/trailing-comma is harmless and matches what
 * openclaw session logs actually emit). Soft-error policy: malformed
 * lines surface as `kind: 'malformed'` AST entries.
 *
 * @module @openclaw/oc-path/jsonl/parse
 */

import { parseJsonc } from "../jsonc/parse.js";
import { sourceLineEnding } from "../source.js";
import type { JsonlAst, JsonlLine } from "./ast.js";

export function parseJsonl(raw: string): JsonlAst {
  // Use the dominant newline (CRLF wins ties) for rendering and unterminated
  // appends. Targeted edits preserve existing separators verbatim.
  const lineEnding = sourceLineEnding(raw);

  // Trim trailing newline so we don't fabricate a blank line at EOF
  // for files that end with `\n` (which is most of them).
  let body = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  // Normalize line endings to LF for consistent splitting; per-line
  // `raw` is stored without the trailing `\r`, and render mode
  // restores the original convention via `lineEnding`.
  body = body.replace(/\r\n/g, "\n");
  const lines: JsonlLine[] = [];

  if (body.length === 0) {
    return { kind: "jsonl", raw, lines, lineEnding };
  }

  const parts = body.split("\n");
  parts.forEach((lineText, idx) => {
    const lineNo = idx + 1;
    if (lineText.trim().length === 0) {
      lines.push({ kind: "blank", line: lineNo, raw: lineText });
      return;
    }
    const r = parseJsonc(lineText);
    if (r.root === null) {
      lines.push({ kind: "malformed", line: lineNo, raw: lineText });
      return;
    }
    lines.push({
      kind: "value",
      line: lineNo,
      value: r.root,
      raw: lineText,
    });
  });

  return { kind: "jsonl", raw, lines, lineEnding };
}
