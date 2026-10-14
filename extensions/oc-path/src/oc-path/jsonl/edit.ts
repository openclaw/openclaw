/**
 * Mutate a `JsonlAst` at an OcPath. Append uses `appendJsonlOcPath`;
 * `setJsonlOcPath` only edits existing addresses.
 *
 * @module @openclaw/oc-path/jsonl/edit
 */

import type { JsoncValue } from "../jsonc/ast.js";
import { resolveJsoncPositionalSegment } from "../jsonc/resolve-value.js";
import type { OcPath } from "../oc-path.js";
import {
  isPositionalSeg,
  parseArrayIndexSegment,
  splitRespectingBrackets,
  unquoteSeg,
} from "../oc-path.js";
import type { JsonlAst, JsonlLine } from "./ast.js";
import { renderJsonl } from "./emit.js";
import { pickJsonlLineIndex } from "./line.js";

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

  const replaced = replaceAt(target.value, segments, 0, newValue);
  if (replaced === null) {
    return { ok: false, reason: "unresolved" };
  }
  return {
    ok: true,
    ast: renderEditedJsonl(ast, ast.lines.with(lineIdx, { ...target, value: replaced }), path.file),
  };
}

function replaceAt(
  current: JsoncValue,
  segments: readonly string[],
  i: number,
  newValue: JsoncValue,
): JsoncValue | null {
  let seg = segments[i];
  if (seg === undefined) {
    return newValue;
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
  const replaced = replaceAt(child, segments, i + 1, newValue);
  if (replaced === null) {
    return null;
  }
  return current.kind === "object"
    ? {
        ...current,
        entries: current.entries.map((entry, at) =>
          at === index ? { ...entry, value: replaced } : entry,
        ),
      }
    : { ...current, items: current.items.with(index, replaced) };
}

function renderEditedJsonl(
  ast: JsonlAst,
  lines: readonly JsonlLine[],
  fileName?: string,
): JsonlAst {
  const next: JsonlAst = {
    kind: "jsonl",
    raw: "",
    lines,
    ...(ast.lineEnding !== undefined ? { lineEnding: ast.lineEnding } : {}),
  };
  return { ...next, raw: renderJsonl(next, fileName) };
}

/** Append a value as the next line. Line numbers are substrate-assigned. */
export function appendJsonlOcPath(ast: JsonlAst, value: JsoncValue): JsonlAst {
  const nextLineNo = ast.lines.length === 0 ? 1 : (ast.lines[ast.lines.length - 1]?.line ?? 0) + 1;
  const newLine: JsonlLine = {
    kind: "value",
    line: nextLineNo,
    value,
    raw: "",
  };
  return renderEditedJsonl(ast, [...ast.lines, newLine]);
}
