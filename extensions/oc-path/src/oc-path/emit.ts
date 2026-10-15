import type { MdAst } from "./ast.js";
import { sourceLineEnding } from "./source.js";

export function replaceMdSource(
  ast: MdAst,
  start: number,
  end: number,
  replacement: string,
  update: (shifted: MdAst) => MdAst,
): MdAst {
  const endLine = ast.raw.slice(0, end).split("\n").length;
  const atLineStart =
    end === 0 || ast.raw[end - 1] === "\n" || (end === 1 && ast.raw[0] === "\uFEFF");
  const delta = replacement.split("\n").length - ast.raw.slice(start, end).split("\n").length;
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
      items: block.items.map((item) => ({ ...item, line: shift(item.line) })),
    })),
  });
  const lines = edited.raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  return {
    ...edited,
    preamble: lines
      .slice(
        edited.frontmatterEndLine ?? 0,
        edited.blocks[0] ? edited.blocks[0].line - 1 : lines.length,
      )
      .join("\n"),
    // oxlint-disable-next-line oxc/no-map-spread -- AST edits must not mutate the caller's nodes.
    blocks: edited.blocks.map((block, index) => {
      const next = edited.blocks[index + 1];
      const bodyText = lines.slice(block.line, next ? next.line - 1 : lines.length).join("\n");
      return bodyText === block.bodyText ? block : { ...block, bodyText };
    }),
  };
}

export function insertMdSource(
  ast: MdAst,
  offset: number,
  text: string,
  update: (shifted: MdAst, line: number) => MdAst,
): MdAst {
  const ending = sourceLineEnding(ast.raw);
  const prefix =
    offset > 0 && ast.raw[offset - 1] !== "\n" && !(offset === 1 && ast.raw[0] === "\uFEFF")
      ? ending
      : "";
  const suffix = offset < ast.raw.length || ast.raw.endsWith("\n") ? ending : "";
  const line = ast.raw.slice(0, offset).split("\n").length + (prefix ? 1 : 0);
  return replaceMdSource(
    ast,
    offset,
    offset,
    prefix + text.replace(/\r?\n/g, ending) + suffix,
    (shifted) => update(shifted, line),
  );
}
