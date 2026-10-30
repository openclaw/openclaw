/**
 * Mutate a `JsonlAst` at an OcPath. Append uses `appendJsonlOcPath`;
 * `setJsonlOcPath` only edits existing addresses.
 *
 * @module @openclaw/oc-path/jsonl/edit
 */

import { findNodeAtLocation, parseTree } from "jsonc-parser/lib/esm/main.js";
import { OcPathEditError } from "../edit-error.js";
import type { JsoncValue } from "../jsonc/ast.js";
import { resolveJsoncValueOcPath } from "../jsonc/resolve-value.js";
import type { OcPath } from "../oc-path.js";
import { splitOcPathSlots } from "../oc-path.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import { sourceLineOffset } from "../source.js";
import type { JsonlAst } from "./ast.js";
import { pickJsonlLineIndex } from "./line.js";
import { parseJsonl } from "./parse.js";

function renderJsoncValue(
  value: JsoncValue,
  guardPath: string,
  walked: readonly string[] = [],
): string {
  if (value.kind === "null") {
    return "null";
  }
  if (value.kind === "number" || value.kind === "boolean") {
    return String(value.value);
  }
  if (value.kind === "string") {
    // Substring match: embedded sentinel leaks marker bytes too.
    if (value.value.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(`${guardPath}/${walked.join("/")}`);
    }
    return JSON.stringify(value.value);
  }
  if (value.kind === "array") {
    const parts = value.items.map((v, i) => renderJsoncValue(v, guardPath, [...walked, String(i)]));
    return `[${parts.join(",")}]`;
  }
  const parts = value.entries.map(
    (e) => `${JSON.stringify(e.key)}:${renderJsoncValue(e.value, guardPath, [...walked, e.key])}`,
  );
  return `{${parts.join(",")}}`;
}

export function setJsonlOcPath(ast: JsonlAst, path: OcPath, newValue: JsoncValue): JsonlAst {
  const head = path.section;
  if (head === undefined) {
    throw new OcPathEditError("unresolved");
  }

  const lineIdx = pickJsonlLineIndex(ast, head);
  const target = ast.lines[lineIdx];
  if (target === undefined) {
    throw new OcPathEditError("unresolved");
  }

  if (target.kind !== "value") {
    throw new OcPathEditError("not-a-value-line");
  }

  const match = resolveJsoncValueOcPath(target.value, splitOcPathSlots(path.item, path.field));
  if (match === null) {
    throw new OcPathEditError("unresolved");
  }
  const editPath = match.path;
  const bomLength = target.raw.startsWith("\uFEFF") ? 1 : 0;
  const tree = parseTree(target.raw.slice(bomLength), [], { allowTrailingComma: true });
  const node = tree && findNodeAtLocation(tree, editPath);
  if (!node) {
    throw new OcPathEditError("unresolved");
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
  return parseJsonl(raw);
}

/** Append a value as the next line. Line numbers are substrate-assigned. */
export function appendJsonlOcPath(ast: JsonlAst, value: JsoncValue): JsonlAst {
  const finalNewline = ast.raw.endsWith("\r\n") ? "\r\n" : ast.raw.endsWith("\n") ? "\n" : "";
  const separator = ast.raw.length > 0 && !finalNewline ? (ast.lineEnding ?? "\n") : "";
  const nextLineNo = ast.raw.split("\n").length + (separator ? 1 : 0);
  const rendered = renderJsoncValue(value, `oc:///L${nextLineNo}`);
  return parseJsonl(ast.raw + separator + rendered + finalNewline);
}
