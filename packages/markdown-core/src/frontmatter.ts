// Markdown Core module implements frontmatter behavior.
import YAML from "yaml";

type ParsedFrontmatter = Record<string, string>;

type ParsedFrontmatterLineEntry = {
  value: string;
  kind: "inline" | "multiline";
  rawInline: string;
};

type ParsedYamlValue = {
  value: string;
  kind: "scalar" | "structured";
};

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function coerceYamlFrontmatterValue(value: unknown): ParsedYamlValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return {
      value: value.trim(),
      kind: "scalar",
    };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return {
      value: String(value),
      kind: "scalar",
    };
  }
  if (typeof value === "object") {
    try {
      return {
        value: JSON.stringify(value),
        kind: "structured",
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseYamlFrontmatter(block: string): Record<string, ParsedYamlValue> | null {
  try {
    const parsed = YAML.parse(block, { schema: "core" }) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const result: Record<string, ParsedYamlValue> = {};
    for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key) {
        continue;
      }
      const coerced = coerceYamlFrontmatterValue(value);
      if (!coerced) {
        continue;
      }
      result[key] = coerced;
    }
    return result;
  } catch {
    return null;
  }
}

function extractMultiLineValue(
  lines: string[],
  startIndex: number,
): {
  value: string;
  linesConsumed: number;
} {
  const valueLines: string[] = [];
  let i = startIndex + 1;

  while (i < lines.length) {
    const line = lines[i];
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }
    valueLines.push(line);
    i += 1;
  }

  const combined = valueLines.join("\n").trim();
  return { value: combined, linesConsumed: i - startIndex };
}

function parseLineFrontmatter(block: string): Record<string, ParsedFrontmatterLineEntry> {
  const result: Record<string, ParsedFrontmatterLineEntry> = {};
  const lines = block.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }

    const key = match[1];
    const inlineValue = match[2].trim();
    if (!key) {
      i += 1;
      continue;
    }

    if (!inlineValue && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (nextLine.startsWith(" ") || nextLine.startsWith("\t")) {
        const { value, linesConsumed } = extractMultiLineValue(lines, i);
        if (value) {
          result[key] = {
            value,
            kind: "multiline",
            rawInline: inlineValue,
          };
        }
        i += linesConsumed;
        continue;
      }
    }

    const value = stripQuotes(inlineValue);
    if (value) {
      result[key] = {
        value,
        kind: "inline",
        rawInline: inlineValue,
      };
    }
    i += 1;
  }

  return result;
}

function lineFrontmatterToPlain(
  parsed: Record<string, ParsedFrontmatterLineEntry>,
): ParsedFrontmatter {
  const result: ParsedFrontmatter = {};
  for (const [key, entry] of Object.entries(parsed)) {
    result[key] = entry.value;
  }
  return result;
}

function isYamlBlockScalarIndicator(value: string): boolean {
  return /^[|>][+-]?(\d+)?[+-]?$/.test(value);
}

function shouldPreferInlineLineValue(params: {
  lineEntry: ParsedFrontmatterLineEntry;
  yamlValue: ParsedYamlValue;
}): boolean {
  const { lineEntry, yamlValue } = params;
  if (yamlValue.kind !== "structured") {
    return false;
  }
  if (lineEntry.kind !== "inline") {
    return false;
  }
  if (isYamlBlockScalarIndicator(lineEntry.rawInline)) {
    return false;
  }
  return lineEntry.value.includes(":");
}

type ExtractedFrontmatterBlock = {
  block: string;
  body: string;
};

const FRONTMATTER_DELIMITER_LINE = /(?:^|\n)---(?:\n|$)/u;

function normalizeFrontmatterContent(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function extractFrontmatterBlock(content: string): ExtractedFrontmatterBlock | undefined {
  const normalized = normalizeFrontmatterContent(content);
  if (!normalized.startsWith("---\n")) {
    return undefined;
  }
  const blockAndBody = normalized.slice(4);
  const closingDelimiter = FRONTMATTER_DELIMITER_LINE.exec(blockAndBody);
  if (!closingDelimiter) {
    return undefined;
  }
  return {
    block: blockAndBody.slice(0, closingDelimiter.index),
    body: blockAndBody.slice(closingDelimiter.index + closingDelimiter[0].length),
  };
}

/** Removes a leading YAML frontmatter block and returns the remaining Markdown body. */
export function stripFrontmatterBlock(content: string): string {
  const normalized = normalizeFrontmatterContent(content);
  return (extractFrontmatterBlock(normalized)?.body ?? normalized).trim();
}

/** Parses leading YAML frontmatter into string values used by skill and metadata loaders. */
export function parseFrontmatterBlock(content: string): ParsedFrontmatter {
  const extracted = extractFrontmatterBlock(content);
  if (!extracted?.block) {
    return {};
  }

  const lineParsed = parseLineFrontmatter(extracted.block);
  const yamlParsed = parseYamlFrontmatter(extracted.block);
  if (yamlParsed === null) {
    return lineFrontmatterToPlain(lineParsed);
  }

  const merged: ParsedFrontmatter = {};
  for (const [key, yamlValue] of Object.entries(yamlParsed)) {
    merged[key] = yamlValue.value;
    const lineEntry = lineParsed[key];
    if (!lineEntry) {
      continue;
    }
    if (shouldPreferInlineLineValue({ lineEntry, yamlValue })) {
      merged[key] = lineEntry.value;
    }
  }

  for (const [key, lineEntry] of Object.entries(lineParsed)) {
    if (!Object.hasOwn(merged, key)) {
      merged[key] = lineEntry.value;
    }
  }

  return merged;
}
