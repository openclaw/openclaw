/**
 * OcPath → MdAst node. Walks an in-memory AST; the file slot is
 * informational (callers verify file matching upstream).
 *
 *   { file }                         → root
 *   { file, section }                → block
 *   { file, section, item }          → item
 *   { file, section, item, field }   → kv.value
 *
 * @module @openclaw/oc-path/resolve
 */

import type { AstItem, MdAst } from "./ast.js";
import type { OcPath } from "./oc-path.js";
import {
  isOrdinalSeg,
  isPositionalSeg,
  parseOrdinalSeg,
  resolvePositionalSeg,
  unquoteSeg,
} from "./oc-path.js";

/**
 * Resolve. Slugs match case-insensitively. `[frontmatter]` is a
 * literal section sentinel; the frontmatter key sits at `item` (or
 * `field` for 4-segment callers).
 */
export function resolveMdOcPath(ast: MdAst, path: OcPath) {
  if (path.section === "[frontmatter]") {
    const key = path.item ?? path.field;
    if (key === undefined) {
      return null;
    }
    const entry = ast.frontmatter.find((e) => e.key === unquoteSeg(key));
    if (entry === undefined) {
      return null;
    }
    return { kind: "frontmatter", node: entry } as const;
  }

  if (path.section === undefined) {
    return { kind: "root", node: ast } as const;
  }

  const block = ast.blocks.find((b) => b.slug === unquoteSeg(path.section!).toLowerCase());
  if (block === undefined) {
    return null;
  }
  if (path.item === undefined) {
    return { kind: "block", node: block } as const;
  }

  // Item dispatch: ordinal (#N) > positional ($last) > slug.
  // Ordinal uses document order so duplicate-slug items stay distinct.
  let item: AstItem | undefined;
  if (isOrdinalSeg(path.item)) {
    const n = parseOrdinalSeg(path.item);
    if (n === null || n < 0 || n >= block.items.length) {
      return null;
    }
    item = block.items[n];
  } else if (isPositionalSeg(path.item)) {
    const concrete = resolvePositionalSeg(path.item, {
      indexable: true,
      size: block.items.length,
    });
    if (concrete === null) {
      return null;
    }
    item = block.items[Number(concrete)];
  } else {
    item = block.items.find((i) => i.slug === unquoteSeg(path.item!).toLowerCase());
  }
  if (item === undefined) {
    return null;
  }
  if (path.field === undefined) {
    return { kind: "item", node: item, block } as const;
  }

  if (item.kv === undefined) {
    return null;
  }
  if (item.kv.key.toLowerCase() !== unquoteSeg(path.field).toLowerCase()) {
    return null;
  }
  /** The kv.value string, surfaced for convenience. */
  return { kind: "item-field", node: item, value: item.kv.value } as const;
}
