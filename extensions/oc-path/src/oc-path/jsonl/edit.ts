/**
 * Mutate a `JsonlAst` at an OcPath. Append uses `appendJsonlOcPath`;
 * `setJsonlOcPath` only edits existing addresses.
 *
 * @module @openclaw/oc-path/jsonl/edit
 */

import type { JsoncEntry, JsoncValue } from "../jsonc/ast.js";
import { resolveJsoncPositionalSegment } from "../jsonc/resolve-value.js";
import type { OcPath } from "../oc-path.js";
import {
  isPositionalSeg,
  parseArrayIndexSegment,
  splitRespectingBrackets,
  unquoteSeg,
} from "../oc-path.js";
import type { JsonlAst, JsonlLine } from "./ast.js";
import { emitJsonl } from "./emit.js";
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
  if (lineIdx === -1) {
    return { ok: false, reason: "unresolved" };
  }
  const target = ast.lines[lineIdx];
  if (target === undefined) {
    return { ok: false, reason: "unresolved" };
  }

  if (target.kind !== "value") {
    return { ok: false, reason: "not-a-value-line" };
  }

  // Quote-aware split keeps edit symmetric with resolveJsonlOcPath.
  const segments: string[] = [];
  if (path.item !== undefined) {
    segments.push(...splitRespectingBrackets(path.item, "."));
  }
  if (path.field !== undefined) {
    segments.push(...splitRespectingBrackets(path.field, "."));
  }

  const replaced = replaceAt(target.value, segments, 0, newValue);
  if (replaced === null) {
    return { ok: false, reason: "unresolved" };
  }
  const newLine: JsonlLine = {
    kind: "value",
    line: target.line,
    value: replaced,
    raw: target.raw,
  };
  const newLines = ast.lines.slice();
  newLines[lineIdx] = newLine;
  return { ok: true, ast: renderEditedJsonl(ast, newLines, path.file) };
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

  if (current.kind === "object") {
    // Positional tokens resolve against the entries' ordered key list;
    // quoted segments are unquoted before literal-key comparison.
    const lookupKey = unquoteSeg(seg);
    const idx = current.entries.findIndex((e) => e.key === lookupKey);
    if (idx === -1) {
      return null;
    }
    const child = current.entries[idx];
    if (child === undefined) {
      return null;
    }
    const replacedChild = replaceAt(child.value, segments, i + 1, newValue);
    if (replacedChild === null) {
      return null;
    }
    const newEntry: JsoncEntry = { ...child, value: replacedChild };
    const newEntries = current.entries.slice();
    newEntries[idx] = newEntry;
    return {
      kind: "object",
      entries: newEntries,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }

  if (current.kind === "array") {
    const idx = parseArrayIndexSegment(seg, current.items.length);
    if (idx === null) {
      return null;
    }
    const child = current.items[idx];
    if (child === undefined) {
      return null;
    }
    const replacedChild = replaceAt(child, segments, i + 1, newValue);
    if (replacedChild === null) {
      return null;
    }
    const newItems = current.items.slice();
    newItems[idx] = replacedChild;
    return {
      kind: "array",
      items: newItems,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }

  return null;
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
  const opts =
    fileName !== undefined
      ? { mode: "render" as const, fileNameForGuard: fileName }
      : { mode: "render" as const };
  const rendered = emitJsonl(next, opts);
  return { ...next, raw: rendered };
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
