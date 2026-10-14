/**
 * Mutate `MdAst` at an OcPath. Returns a new AST; original unchanged.
 *
 *   oc://FILE/[frontmatter]/key   → frontmatter value
 *   oc://FILE/section/item/field  → item.kv.value
 *
 * Section bodies aren't writable through this primitive.
 *
 * @module @openclaw/oc-path/edit
 */

import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import type { AstItem, FrontmatterEntry, MdAst } from "./ast.js";
import { rebuildMdRaw } from "./emit.js";
import { formatOcPath, type OcPath } from "./oc-path.js";
import { resolveMdOcPath } from "./resolve.js";
import { guardSentinel } from "./sentinel.js";

type MdEditResult =
  | { readonly ok: true; readonly ast: MdAst }
  | {
      readonly ok: false;
      readonly reason: "unresolved" | "not-writable" | "no-item-kv";
    };

// Sentinel guard at the boundary keeps md symmetric with jsonc/jsonl,
// which both reject sentinel values before they reach the AST.
export function setMdOcPath(ast: MdAst, path: OcPath, newValue: string): MdEditResult {
  guardSentinel(newValue, formatOcPath(path));
  if (path.section === "[frontmatter]") {
    const key = path.item ?? path.field;
    if (key === undefined) {
      return { ok: false, reason: "unresolved" };
    }
    const idx = ast.frontmatter.findIndex((e) => e.key === key);
    const existing = ast.frontmatter[idx];
    if (existing === undefined) {
      return { ok: false, reason: "unresolved" };
    }
    const newEntry: FrontmatterEntry = { ...existing, value: newValue };
    const newFm = ast.frontmatter.slice();
    newFm[idx] = newEntry;
    return { ok: true, ast: rebuildMdRaw({ ...ast, frontmatter: newFm }) };
  }

  if (path.section === undefined || path.item === undefined || path.field === undefined) {
    return { ok: false, reason: "not-writable" };
  }

  const match = resolveMdOcPath(ast, { ...path, field: undefined });
  if (match?.kind !== "item") {
    return { ok: false, reason: "unresolved" };
  }
  const { node: item, block } = match;
  if (item.kv === undefined) {
    return { ok: false, reason: "no-item-kv" };
  }
  if (item.kv.key.toLowerCase() !== path.field.toLowerCase()) {
    return { ok: false, reason: "unresolved" };
  }

  const bodyLines = block.bodyText.split("\n");
  const bodyLine = item.line - block.line - 1;
  const prefix = new RegExp(`^([\\s\\S]*?${escapeRegExp(item.kv.key)}[ \\t]*:[ \\t]*)`).exec(
    bodyLines.slice(bodyLine).join("\n"),
  )?.[1];
  if (prefix === undefined) {
    return { ok: false, reason: "unresolved" };
  }
  const prefixLines = prefix.split("\n");
  const oldLineCount = item.kv.value.split("\n").length;
  const lineDelta = newValue.split("\n").length - oldLineCount;
  if (item.kv.value !== newValue) {
    // Restrict replacement to the selected item; duplicate keys and code fences
    // elsewhere in the block must not redirect the write.
    bodyLines.splice(
      bodyLine + prefixLines.length - 1,
      oldLineCount,
      `${prefix.slice(prefix.lastIndexOf("\n") + 1)}${newValue}`,
    );
  }
  const newItem: AstItem = { ...item, kv: { key: item.kv.key, value: newValue } };
  const itemIdx = block.items.indexOf(item);
  const newItems = block.items.map((entry, index) =>
    index === itemIdx
      ? newItem
      : index > itemIdx && lineDelta !== 0
        ? { ...entry, line: entry.line + lineDelta }
        : entry,
  );
  const newBlocks = ast.blocks.slice();
  newBlocks[ast.blocks.indexOf(block)] = {
    ...block,
    items: newItems,
    bodyText: bodyLines.join("\n"),
  };
  return { ok: true, ast: rebuildMdRaw({ ...ast, blocks: newBlocks }) };
}
