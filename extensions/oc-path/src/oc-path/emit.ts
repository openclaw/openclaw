import type { MdAst } from "./ast.js";
import { formatFrontmatterValue } from "./frontmatter-format.js";

// Editing guards new values separately, preserving unrelated pre-existing sentinel text.
export function rebuildMdRaw(ast: MdAst): MdAst {
  const parts: string[] = [];
  let nextLine = 1;
  const append = (text: string) => {
    parts.push(text);
    nextLine += text.split("\n").length;
  };
  if (ast.frontmatter.length > 0) {
    append("---");
    for (const fm of ast.frontmatter) {
      append(`${fm.key}: ${formatFrontmatterValue(fm.value)}`);
    }
    append("---");
  }
  if (ast.preamble.length > 0) {
    if (parts.length > 0) {
      append("");
    }
    append(ast.preamble);
  }
  const blocks = ast.blocks.map((block) => {
    if (parts.length > 0) {
      append("");
    }
    const line = nextLine;
    append(`## ${block.heading}`);
    if (block.bodyText.length > 0) {
      append(block.bodyText);
    }
    // Rendering can move a block without changing its body. Keep item offsets
    // aligned for subsequent writes without reparsing explicit field values.
    const shift = line - block.line;
    return shift === 0
      ? block
      : {
          ...block,
          line,
          items: block.items.map((item) => ({ ...item, line: item.line + shift })),
        };
  });
  return { ...ast, blocks, raw: parts.join("\n") };
}
