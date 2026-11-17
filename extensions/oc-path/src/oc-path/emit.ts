import type { AstBlock, MdAst } from "./ast.js";
import type { JsoncEntry } from "./jsonc/ast.js";
import { guardSentinel } from "./sentinel.js";
import { sourceLineEnding } from "./source.js";

export function replaceMdSource(
  ast: MdAst,
  start: number,
  end: number,
  replacement: string,
  update: (shifted: MdAst) => MdAst,
): MdAst {
  const endLine = ast.raw.slice(0, end).split(/\r\n?|\n/).length;
  const atLineStart =
    end === 0 || /[\r\n]/.test(ast.raw[end - 1] ?? "") || (end === 1 && ast.raw[0] === "\uFEFF");
  const delta =
    replacement.split(/\r\n?|\n/).length - ast.raw.slice(start, end).split(/\r\n?|\n/).length;
  const shift = (line: number) =>
    line > endLine || (atLineStart && line === endLine) ? line + delta : line;
  // Keep explicit multiline values as one addressed item; reparsing would turn
  // literal Markdown inside a value into additional addressable nodes.
  const edited = update({
    ...ast,
    raw: ast.raw.slice(0, start) + replacement + ast.raw.slice(end),
    frontmatterEndLine:
      ast.frontmatterEndLine === undefined ? undefined : shift(ast.frontmatterEndLine),
    frontmatter: ast.frontmatter.map((entry) => ({ ...entry, line: shift(entry.line) })),
    blocks: ast.blocks.map((block) => ({
      ...block,
      line: shift(block.line),
      items: block.items.map((item) => ({
        ...item,
        line: shift(item.line),
        textLine: item.textLine === null ? null : shift(item.textLine),
      })),
    })),
  });
  const lines = edited.raw.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const blocks: AstBlock[] = [];
  for (const [index, block] of edited.blocks.entries()) {
    const next = edited.blocks[index + 1];
    const bodyText = lines.slice(block.line, next ? next.line - 1 : lines.length).join("\n");
    blocks.push(bodyText === block.bodyText ? block : { ...block, bodyText });
  }
  return {
    ...edited,
    preamble: lines
      .slice(
        edited.frontmatterEndLine ?? 0,
        edited.blocks[0] ? edited.blocks[0].line - 1 : lines.length,
      )
      .join("\n"),
    blocks,
  };
}

export function insertMdSource(
  ast: MdAst,
  offset: number,
  text: string,
  update: (shifted: MdAst, line: number) => MdAst,
): MdAst {
  const ending = sourceLineEnding(ast.raw, true);
  const prefix =
    offset > 0 &&
    !/[\r\n]/.test(ast.raw[offset - 1] ?? "") &&
    !(offset === 1 && ast.raw[0] === "\uFEFF")
      ? ending
      : "";
  const suffix = offset < ast.raw.length || /[\r\n]$/.test(ast.raw) ? ending : "";
  const line = ast.raw.slice(0, offset).split(/\r\n?|\n/).length + (prefix ? 1 : 0);
  const normalized = text.replace(/\r\n?|\n/g, ending);
  // Keep a leading LF from merging with an existing CR into one line break.
  const insertion =
    ast.raw[offset - 1] === "\r" && normalized.startsWith("\n") ? `\r${normalized}` : normalized;
  return replaceMdSource(ast, offset, offset, prefix + insertion + suffix, (shifted) =>
    update(shifted, line),
  );
}

/** Emit new object entries with the same key guard regardless of JSON format. */
export function emitJsoncObjectEntries<T>(
  entries: readonly JsoncEntry[],
  parentPath: string,
  emit: (entry: JsoncEntry, path: string) => T,
): T[] {
  return entries.map((entry) => {
    const path = guardedJsoncKeyPath(entry.key, parentPath);
    return emit(entry, path);
  });
}

export function guardedJsoncKeyPath(key: string, parentPath: string): string {
  const path = `${parentPath}/${key}`;
  guardSentinel(key, path);
  return path;
}
