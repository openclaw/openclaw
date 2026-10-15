/**
 * Mutate a `JsonlAst` at an OcPath. Append uses `appendJsonlOcPath`;
 * `setJsonlOcPath` only edits existing addresses.
 *
 * @module @openclaw/oc-path/jsonl/edit
 */

import { findNodeAtLocation, parseTree } from "jsonc-parser/lib/esm/main.js";
import type { JsoncValue } from "../jsonc/ast.js";
import { renderJsoncValue } from "../jsonc/emit.js";
import { resolveJsoncValueOcPath } from "../jsonc/resolve-value.js";
import type { OcPath } from "../oc-path.js";
import { splitOcPathSlots } from "../oc-path.js";
import { sourceLineOffset } from "../source.js";
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

  const match = resolveJsoncValueOcPath(target.value, splitOcPathSlots(path.item, path.field));
  if (match === null) {
    return { ok: false, reason: "unresolved" };
  }
  const editPath = match.path;
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
  const start = sourceLineOffset(ast.raw, target.line) + bomLength + node.offset;
  // Replace only the selected source token. Re-rendering parsed siblings rounds
  // large integers and removes comments, escapes, and record separators.
  const raw = ast.raw.slice(0, start) + replacement + ast.raw.slice(start + node.length);
  return { ok: true, ast: parseJsonl(raw).ast };
}

/** Append a value as the next line. Line numbers are substrate-assigned. */
export function appendJsonlOcPath(ast: JsonlAst, value: JsoncValue): JsonlAst {
  const finalNewline = ast.raw.endsWith("\r\n") ? "\r\n" : ast.raw.endsWith("\n") ? "\n" : "";
  const separator = ast.raw.length > 0 && !finalNewline ? (ast.lineEnding ?? "\n") : "";
  const nextLineNo = ast.raw.split("\n").length + (separator ? 1 : 0);
  const rendered = renderJsoncValue(value, `oc:///L${nextLineNo}`);
  return parseJsonl(ast.raw + separator + rendered + finalNewline).ast;
}
