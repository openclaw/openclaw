const MARKDOWN_TABLE_REGEX = /^\|(.+)\|[\r\n]+\|[-:\s|]+\|[\r\n]+((?:\|.+\|[\r\n]*)+)/gm;
const MARKDOWN_CODE_BLOCK_REGEX = /```(\w*)\n([\s\S]*?)```/g;

export type NaverWorksFlexBoxLayout = "horizontal" | "vertical" | "baseline";

export type NaverWorksFlexComponent =
  | {
      type: "text";
      text: string;
      size?: "xs" | "sm" | "md";
      weight?: "bold";
      color?: string;
      wrap?: boolean;
      margin?: "none" | "sm" | "md";
      flex?: number;
    }
  | {
      type: "separator";
      margin?: "none" | "sm" | "md";
    }
  | {
      type: "box";
      layout: NaverWorksFlexBoxLayout;
      contents: NaverWorksFlexComponent[];
      margin?: "none" | "sm" | "md";
      spacing?: "none" | "sm";
    };

export type NaverWorksFlexBubble = {
  type: "bubble";
  body: {
    type: "box";
    layout: "vertical";
    contents: NaverWorksFlexComponent[];
  };
};

export type NaverWorksFlexContainer = NaverWorksFlexBubble;

export function hasMarkdownFeatures(text: string): boolean {
  const input = text.trim();
  if (!input) {
    return false;
  }
  MARKDOWN_TABLE_REGEX.lastIndex = 0;
  MARKDOWN_CODE_BLOCK_REGEX.lastIndex = 0;
  return (
    MARKDOWN_TABLE_REGEX.test(input) ||
    MARKDOWN_CODE_BLOCK_REGEX.test(input) ||
    /^\s*[-*+]\s+/m.test(input) ||
    /^\s*#{1,6}\s+/m.test(input) ||
    /\[[^\]]+\]\([^)]+\)/.test(input)
  );
}

function extractCodeBlocks(text: string): { codeBlocks: string[]; textWithoutCode: string } {
  MARKDOWN_CODE_BLOCK_REGEX.lastIndex = 0;
  const codeBlocks: string[] = [];
  const textWithoutCode = text.replace(MARKDOWN_CODE_BLOCK_REGEX, (_full, language, body) => {
    const lang = String(language || "").trim();
    const code = String(body || "").trim();
    const label = lang ? `Code (${lang})` : "Code";
    codeBlocks.push(`${label}\n${code}`.trim());
    return "";
  });
  return { codeBlocks, textWithoutCode };
}

function parseTableRow(row: string): string[] {
  return row
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell, index, arr) => !((index === 0 || index === arr.length - 1) && cell === ""));
}

function extractTables(text: string): { tables: string[]; textWithoutTables: string } {
  MARKDOWN_TABLE_REGEX.lastIndex = 0;
  const matches: { fullMatch: string; summary: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = MARKDOWN_TABLE_REGEX.exec(text)) !== null) {
    const headers = parseTableRow(match[1] ?? "");
    const rows = (match[2] ?? "")
      .trim()
      .split(/[\r\n]+/)
      .filter((line) => line.trim())
      .map(parseTableRow);

    if (headers.length === 0 || rows.length === 0) {
      continue;
    }

    const previewRows = rows
      .slice(0, 3)
      .map((row) => headers.map((header, index) => `${header}: ${row[index] ?? "-"}`).join(" | "));
    const extraCount = rows.length - previewRows.length;
    const suffix = extraCount > 0 ? `\n... and ${extraCount} more row(s)` : "";
    matches.push({
      fullMatch: match[0],
      summary: `Table\n${previewRows.join("\n")}${suffix}`,
    });
  }

  let textWithoutTables = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    textWithoutTables = textWithoutTables.replace(matches[i].fullMatch, "");
  }

  return {
    tables: matches.map((entry) => entry.summary),
    textWithoutTables,
  };
}

function normalizeInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .trim();
}

function toTextComponent(
  text: string,
  options?: { bold?: boolean; margin?: "none" | "sm" | "md"; color?: string; size?: "sm" | "md" },
) {
  return {
    type: "text" as const,
    text,
    wrap: true,
    size: (options?.size ?? "md") as const,
    color: options?.color,
    weight: options?.bold ? ("bold" as const) : undefined,
    margin: options?.margin,
  };
}

function buildAltText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "OpenClaw message";
  }
  return normalized.slice(0, 400);
}

export function markdownToNaverWorksFlexTemplate(
  text: string,
  options?: { theme?: "light" | "dark" | "auto" },
): {
  altText: string;
  contents: NaverWorksFlexContainer;
} | null {
  const trimmed = text.trim();
  if (!trimmed || !hasMarkdownFeatures(trimmed)) {
    return null;
  }

  const { codeBlocks, textWithoutCode } = extractCodeBlocks(trimmed);
  const { tables, textWithoutTables } = extractTables(textWithoutCode);
  const normalizedText = normalizeInlineMarkdown(textWithoutTables);
  const lines = normalizedText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const resolvedTheme = options?.theme ?? "auto";
  const textColor = resolvedTheme === "dark" ? "#f5f5f5" : "#111111";
  const sectionTitleColor = resolvedTheme === "dark" ? "#ffffff" : "#000000";

  const contents: NaverWorksFlexComponent[] = [];

  if (lines.length > 0) {
    contents.push(toTextComponent(lines[0], { bold: true, color: sectionTitleColor, size: "md" }));
    for (const line of lines.slice(1)) {
      contents.push(toTextComponent(line, { margin: "sm", color: textColor, size: "md" }));
    }
  }

  for (const table of tables) {
    if (contents.length > 0) {
      contents.push({ type: "separator", margin: "md" });
    }
    const tableLines = table.split("\n").filter(Boolean);
    contents.push(
      toTextComponent(tableLines[0] ?? "Table", {
        bold: true,
        margin: "sm",
        color: sectionTitleColor,
        size: "md",
      }),
    );
    for (const line of tableLines.slice(1)) {
      contents.push(toTextComponent(line, { margin: "sm", color: textColor, size: "md" }));
    }
  }

  for (const codeBlock of codeBlocks) {
    if (contents.length > 0) {
      contents.push({ type: "separator", margin: "md" });
    }
    const codeLines = codeBlock.split("\n").filter(Boolean);
    contents.push(
      toTextComponent(codeLines[0] ?? "Code", {
        bold: true,
        margin: "sm",
        color: sectionTitleColor,
        size: "md",
      }),
    );
    for (const line of codeLines.slice(1)) {
      contents.push(toTextComponent(line, { margin: "sm", color: textColor, size: "md" }));
    }
  }

  if (contents.length === 0) {
    contents.push(
      toTextComponent(normalizedText || trimmed, {
        color: textColor,
        size: "md",
      }),
    );
  }

  return {
    altText: buildAltText(normalizedText || trimmed),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents,
      },
    },
  };
}
