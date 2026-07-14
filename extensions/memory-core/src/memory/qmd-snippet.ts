export type ParsedQmdSnippet = {
  snippet: string;
  startLine?: number;
  endLine?: number;
  strippedEnvelope: boolean;
};

const QMD_HEADER_LINE_RE = /^@@\s*-(\d+),(\d+)(?:\s*@@(?:\s*\(\d+\s+before,\s*\d+\s+after\))?)?$/;
const MCP_NUMBERED_LINE_RE = /^(\d+):(?: ?)(.*)$/;

function parsePositiveSafeInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseHeaderLine(line: string): { startLine: number; endLine: number } | null {
  const match = QMD_HEADER_LINE_RE.exec(line);
  if (!match) {
    return null;
  }
  const startLine = parsePositiveSafeInteger(match[1]);
  const count = parsePositiveSafeInteger(match[2]);
  if (startLine === undefined || count === undefined) {
    return null;
  }
  const endLine = startLine + count - 1;
  if (!Number.isSafeInteger(endLine)) {
    return null;
  }
  return { startLine, endLine };
}

/**
 * Remove QMD's leading location envelope while preserving ordinary document
 * text. The MCP transport also numbers every returned line; those prefixes are
 * removed only when the complete body is a consecutive sequence.
 */
export function parseQmdSnippet(raw: string): ParsedQmdSnippet {
  const snippet = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const newline = snippet.includes("\r\n") ? "\r\n" : "\n";
  const lines = snippet.split(/\r?\n/);
  const trailingNewline = lines.length > 1 && lines.at(-1) === "";
  if (trailingNewline) {
    lines.pop();
  }

  const rawHeader = parseHeaderLine(lines[0] ?? "");
  if (rawHeader) {
    return {
      snippet: lines.slice(1).join(newline) + (trailingNewline && lines.length > 1 ? newline : ""),
      ...rawHeader,
      strippedEnvelope: true,
    };
  }

  const numberedHeader = MCP_NUMBERED_LINE_RE.exec(lines[0] ?? "");
  const header = numberedHeader ? parseHeaderLine(numberedHeader[2]) : null;
  const headerNumber = numberedHeader ? parsePositiveSafeInteger(numberedHeader[1]) : undefined;
  if (!header || headerNumber === undefined) {
    return { snippet: raw, strippedEnvelope: false };
  }

  const body = lines.slice(1);
  const unnumbered: string[] = [];
  let expectedLine = headerNumber + 1;
  let completeSequence = true;
  for (const line of body) {
    const match = MCP_NUMBERED_LINE_RE.exec(line);
    const lineNumber = match ? parsePositiveSafeInteger(match[1]) : undefined;
    if (!match || lineNumber !== expectedLine) {
      completeSequence = false;
      break;
    }
    unnumbered.push(match[2]);
    expectedLine += 1;
  }

  const cleanedLines = completeSequence ? unnumbered : body;
  return {
    snippet:
      cleanedLines.join(newline) + (trailingNewline && cleanedLines.length > 0 ? newline : ""),
    ...header,
    strippedEnvelope: true,
  };
}
