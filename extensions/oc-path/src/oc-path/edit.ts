import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { isAlias, isNode, parseDocument } from "yaml";
import type { MdAst } from "./ast.js";
import { OcPathEditError } from "./edit-error.js";
import { replaceMdSource } from "./emit.js";
import { formatFrontmatterValue } from "./frontmatter-format.js";
import { formatOcPath, unquoteSeg, type OcPath } from "./oc-path.js";
import { resolveMdOcPath } from "./resolve.js";
import { guardSentinel } from "./sentinel.js";
import { sourceLineEnding, sourceLineOffset } from "./source.js";

export function setMdOcPath(ast: MdAst, path: OcPath, newValue: string): MdAst {
  guardSentinel(newValue, formatOcPath(path));
  if (path.section === "[frontmatter]") {
    const match = resolveMdOcPath(ast, path);
    if (match?.kind !== "frontmatter" || ast.frontmatterEndLine === undefined) {
      throw new OcPathEditError("unresolved");
    }
    const existing = match.node;
    const offset = sourceLineOffset(ast.raw, existing.line);
    const source = ast.raw.slice(offset, sourceLineOffset(ast.raw, ast.frontmatterEndLine));
    const prefix = /^[^:\r\n]*:[ \t]*/.exec(source)?.[0];
    // YAML owns the selected value's extent, including block scalars and maps.
    const value = parseDocument(source, { prettyErrors: false, logLevel: "silent" }).get(
      existing.key,
      true,
    );
    if (prefix === undefined || !isNode(value) || !value.range) {
      throw new OcPathEditError("unresolved");
    }
    const end = value.range[1];
    const ending = source.slice(0, end).match(/\r?\n$/)?.[0] ?? "";
    const anchor = !isAlias(value) && value.anchor ? `&${value.anchor} ` : "";
    const idx = ast.frontmatter.indexOf(existing);
    return replaceMdSource(
      ast,
      offset + prefix.length,
      offset + end,
      (prefix.endsWith(":") ? " " : "") + anchor + formatFrontmatterValue(newValue) + ending,
      (shifted) => ({
        ...shifted,
        frontmatter: shifted.frontmatter.map((entry, index) =>
          index === idx ? { ...entry, value: newValue } : entry,
        ),
      }),
    );
  }

  if (path.section === undefined || path.item === undefined || path.field === undefined) {
    throw new OcPathEditError("not-writable");
  }
  const match = resolveMdOcPath(ast, { ...path, field: undefined });
  if (match?.kind !== "item") {
    throw new OcPathEditError("unresolved");
  }
  const { node: item, block } = match;
  if (item.kv === undefined) {
    throw new OcPathEditError("no-item-kv");
  }
  if (item.kv.key.toLowerCase() !== unquoteSeg(path.field).toLowerCase()) {
    throw new OcPathEditError("unresolved");
  }
  const key = item.kv.key;
  const offset = sourceLineOffset(ast.raw, item.line);
  const prefix = new RegExp(`^([\\s\\S]*?${escapeRegExp(item.kv.key)}[ \\t]*:\\s*)`).exec(
    ast.raw.slice(offset),
  )?.[1];
  if (prefix === undefined) {
    throw new OcPathEditError("unresolved");
  }
  const start = offset + prefix.length;
  const lastLine = item.line + prefix.split("\n").length + item.kv.value.split("\n").length - 2;
  const lineEnd = sourceLineOffset(ast.raw, lastLine + 1);
  const ending = ast.raw.slice(start, lineEnd).match(/\r?\n$/)?.[0] ?? "";
  const blockIdx = ast.blocks.indexOf(block);
  const itemIdx = block.items.indexOf(item);
  return replaceMdSource(
    ast,
    start,
    lineEnd - ending.length,
    newValue.replace(/\r?\n/g, sourceLineEnding(ast.raw)),
    (shifted) => ({
      ...shifted,
      blocks: shifted.blocks.map((entry, index) =>
        index !== blockIdx
          ? entry
          : {
              ...entry,
              items: entry.items.map((child, childIndex) =>
                childIndex !== itemIdx ? child : { ...child, kv: { key, value: newValue } },
              ),
            },
      ),
    }),
  );
}
