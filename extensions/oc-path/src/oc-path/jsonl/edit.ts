/**
 * Mutate a `JsonlAst` at an OcPath. Append uses `appendJsonlOcPath`;
 * `setJsonlOcPath` only edits existing addresses.
 *
 * @module @openclaw/oc-path/jsonl/edit
 */

import { findNodeAtLocation, parseTree } from "jsonc-parser/lib/esm/main.js";
import type { JsoncValue } from "../jsonc/ast.js";
import { renderJsoncValue } from "../jsonc/emit.js";
import { resolveJsoncPositionalSegment } from "../jsonc/resolve-value.js";
import type { OcPath } from "../oc-path.js";
import {
  isPositionalSeg,
  parseArrayIndexSegment,
  splitRespectingBrackets,
  unquoteSeg,
} from "../oc-path.js";
import type { JsonlAst } from "./ast.js";
import { pickJsonlLineIndex } from "./line.js";
import { parseJsonl } from "./parse.js";

type JsonlEditResult =
  | { readonly ok: true; readonly ast: JsonlAst }
  | { readonly ok: false; readonly reason: "unresolved" | "not-a-value-line" };

export function setJsonlOcPath(ast: JsonlAst, path: OcPath, newValue: JsoncValue): JsonlEditResult {
  const head = path.section;
  if (head === undefined) {
    return { ok: false, reason: "unresolved" };
  }

  const lineIdx = pickJsonlLineIndex(ast, head);
  const target = ast.lines[lineIdx];
  if (target === undefined) {
    return { ok: false, reason: "unresolved" };
  }

  if (target.kind !== "value") {
    return { ok: false, reason: "not-a-value-line" };
  }

  // Quote-aware split keeps edit symmetric with resolveJsonlOcPath.
  const segments = [path.item, path.field].flatMap((slot) =>
    slot === undefined ? [] : splitRespectingBrackets(slot, "."),
  );

  const editPath = resolveEditPath(target.value, segments, 0);
  if (editPath === null) {
    return { ok: false, reason: "unresolved" };
  }
  const bomLength = target.raw.startsWith("\uFEFF") ? 1 : 0;
  const tree = parseTree(target.raw.slice(bomLength), [], { allowTrailingComma: true });
  const node = tree && findNodeAtLocation(tree, editPath);
  if (!node) {
    return { ok: false, reason: "unresolved" };
  }
  const replacement = renderJsoncValue(
    newValue,
    `oc://${path.file}/L${target.line}`,
    editPath.map(String),
  );
  let lineOffset = 0;
  for (let line = 0; line < lineIdx; line += 1) {
    lineOffset = ast.raw.indexOf("\n", lineOffset) + 1;
  }
  const start = lineOffset + bomLength + node.offset;
  // Replace only the selected source token. Re-rendering parsed siblings rounds
  // large integers and removes comments, escapes, and record separators.
  const raw = ast.raw.slice(0, start) + replacement + ast.raw.slice(start + node.length);
  return { ok: true, ast: parseJsonl(raw).ast };
}

function resolveEditPath(
  current: JsoncValue,
  segments: readonly string[],
  i: number,
): (string | number)[] | null {
  let seg = segments[i];
  if (seg === undefined) {
    return [];
  }
  if (seg.length === 0) {
    return null;
  }
  if (isPositionalSeg(seg)) {
    const resolved = resolveJsoncPositionalSegment(current, seg);
    if (resolved === null) {
      return null;
    }
    seg = resolved;
  }

  if (current.kind !== "object" && current.kind !== "array") {
    return null;
  }
  // Positional tokens use the ordered key list; quoted keys remain literal.
  const lookupKey = unquoteSeg(seg);
  const index =
    current.kind === "object"
      ? current.entries.findIndex((entry) => entry.key === lookupKey)
      : (parseArrayIndexSegment(seg, current.items.length) ?? -1);
  const child = current.kind === "object" ? current.entries[index]?.value : current.items[index];
  if (child === undefined) {
    return null;
  }
  const rest = resolveEditPath(child, segments, i + 1);
  return rest === null ? null : [current.kind === "object" ? lookupKey : index, ...rest];
}

/** Append a value as the next line. Line numbers are substrate-assigned. */
export function appendJsonlOcPath(ast: JsonlAst, value: JsoncValue): JsonlAst {
  const finalNewline = ast.raw.endsWith("\r\n") ? "\r\n" : ast.raw.endsWith("\n") ? "\n" : "";
  const separator = ast.raw.length > 0 && !finalNewline ? (ast.lineEnding ?? "\n") : "";
  const nextLineNo = ast.raw.split("\n").length + (separator ? 1 : 0);
  const rendered = renderJsoncValue(value, `oc:///L${nextLineNo}`);
  return parseJsonl(ast.raw + separator + rendered + finalNewline).ast;
}
