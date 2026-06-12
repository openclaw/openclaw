// QQ Bot Markdown chunking keeps each sent message self-contained.

export type QQBotBaseMarkdownChunker = (text: string, limit: number) => string[];

type TableHeader = {
  header: string;
  separator: string;
  cells: string[];
};

export type QQBotMarkdownChunker = {
  chunkText: (text: string, limit: number) => string[];
  flushPendingText: (limit: number) => string[];
};

export function chunkQQBotMarkdownText(
  text: string,
  limit: number,
  baseChunker: QQBotBaseMarkdownChunker,
): string[] {
  const chunker = createQQBotMarkdownChunker(baseChunker);
  return [...chunker.chunkText(text, limit), ...chunker.flushPendingText(limit)];
}

export function createQQBotMarkdownChunker(
  baseChunker: QQBotBaseMarkdownChunker,
): QQBotMarkdownChunker {
  const state = new QQBotMarkdownChunkingState(baseChunker);
  return {
    chunkText: (text, limit) => state.chunkText(text, limit),
    flushPendingText: (limit) => state.flushPendingText(limit),
  };
}

class QQBotMarkdownChunkingState {
  private activeTable: TableHeader | null = null;
  private pendingHeaderLine: string | null = null;
  private pendingHeaderCells: string[] = [];
  private tableLines: string[] = [];
  private textLines: string[] = [];
  private pendingRowFragment: string | null = null;
  private inFence = false;
  private fenceMarker: string | null = null;

  constructor(private readonly baseChunker: QQBotBaseMarkdownChunker) {}

  chunkText(text: string, limit: number): string[] {
    if (!text) {
      return [];
    }
    if (limit <= 0) {
      return this.baseChunker(text, limit);
    }

    const chunks: string[] = [];
    const textWithPendingRow = this.consumePendingRowPrefix(text);
    const lines = textWithPendingRow.split("\n");
    for (const [index, line] of lines.entries()) {
      const isTrailingSplitLine = index === lines.length - 1 && line === "";
      this.consumeLine(line, {
        limit,
        chunks,
        isTrailingSplitLine,
        isLastLine: index === lines.length - 1,
      });
    }
    this.flushPendingHeaderAsText();
    this.flushText(chunks, limit);
    this.flushTable(chunks);
    return chunks;
  }

  flushPendingText(limit: number): string[] {
    const chunks: string[] = [];
    this.flushPendingRowFragment(chunks, limit);
    this.flushPendingHeaderAsText();
    this.flushText(chunks, limit);
    this.flushTable(chunks);
    return chunks;
  }

  private consumeLine(
    line: string,
    params: {
      limit: number;
      chunks: string[];
      isTrailingSplitLine: boolean;
      isLastLine: boolean;
    },
  ): void {
    const fence = parseFenceLine(line);
    if (fence) {
      this.endTable(params.chunks);
      this.pushTextLine(line);
      if (!this.inFence) {
        this.inFence = true;
        this.fenceMarker = fence.marker;
      } else if (this.fenceMarker === fence.marker) {
        this.inFence = false;
        this.fenceMarker = null;
      }
      this.pendingHeaderLine = null;
      this.pendingHeaderCells = [];
      return;
    }

    if (this.inFence) {
      this.pushTextLine(line);
      return;
    }

    if (
      isIncompleteTableRowFragment(line) ||
      (this.activeTable && isShortTableRowLine(line, this.activeTable))
    ) {
      if (params.isLastLine) {
        this.flushText(params.chunks, params.limit);
        this.pendingRowFragment = mergeRowFragments(this.pendingRowFragment, line);
        return;
      }
      this.pushTextLine(renderMalformedPipeLineAsText(line));
      return;
    }

    if (this.pendingHeaderLine && isTableSeparatorLine(line)) {
      this.flushText(params.chunks, params.limit);
      this.activeTable = {
        header: this.pendingHeaderLine,
        separator: line,
        cells: this.pendingHeaderCells,
      };
      this.pendingHeaderLine = null;
      this.pendingHeaderCells = [];
      this.ensureTableHeader();
      return;
    }

    if (isTableRowLine(line) && this.activeTable && !isTableSeparatorLine(line)) {
      this.flushText(params.chunks, params.limit);
      this.appendTableRow(line, params.limit, params.chunks);
      return;
    }

    if (this.activeTable) {
      if (!line.trim() && params.isTrailingSplitLine) {
        return;
      }
      this.endTable(params.chunks);
    }

    if (isTableRowLine(line) && !isTableSeparatorLine(line)) {
      this.flushText(params.chunks, params.limit);
      this.pendingHeaderLine = line;
      this.pendingHeaderCells = splitTableCells(line);
      return;
    }

    this.pendingHeaderLine = null;
    this.pendingHeaderCells = [];
    this.pushTextLine(line);
  }

  private pushTextLine(line: string): void {
    this.textLines.push(line);
  }

  private appendTableRow(line: string, limit: number, chunks: string[]): void {
    const rowMessage = [this.activeTable!.header, this.activeTable!.separator, line].join("\n");
    if (rowMessage.length > limit) {
      this.dropHeaderOnlyTableChunk();
      this.flushTable(chunks);
      this.pushOversizedTableRow(line, limit, chunks);
      return;
    }

    this.ensureTableHeader();
    const candidate = [...this.tableLines, line].join("\n");
    if (candidate.length <= limit) {
      this.tableLines.push(line);
      return;
    }

    this.flushTable(chunks);
    this.ensureTableHeader();
    this.tableLines.push(line);
  }

  private pushOversizedTableRow(line: string, limit: number, chunks: string[]): void {
    const text = renderTableRowAsFields(this.activeTable!.cells, splitTableCells(line));
    for (const chunk of this.baseChunker(text, limit)) {
      if (chunk) {
        chunks.push(chunk);
      }
    }
  }

  private ensureTableHeader(): void {
    if (this.tableLines.length > 0 || !this.activeTable) {
      return;
    }
    this.tableLines.push(this.activeTable.header, this.activeTable.separator);
  }

  private flushText(chunks: string[], limit: number): void {
    if (this.textLines.length === 0) {
      return;
    }
    const text = this.textLines.join("\n");
    this.textLines = [];
    if (!text) {
      return;
    }
    for (const chunk of this.baseChunker(text, limit)) {
      if (chunk) {
        chunks.push(chunk);
      }
    }
  }

  private flushPendingHeaderAsText(): void {
    if (!this.pendingHeaderLine) {
      return;
    }
    this.pushTextLine(this.pendingHeaderLine);
    this.pendingHeaderLine = null;
    this.pendingHeaderCells = [];
  }

  private consumePendingRowPrefix(text: string): string {
    if (!this.pendingRowFragment) {
      return text;
    }
    const separator =
      this.pendingRowFragment.trimEnd().endsWith("|") && text && !/^[\s|]/.test(text) ? " " : "";
    const merged = `${this.pendingRowFragment}${separator}${text}`;
    this.pendingRowFragment = null;
    return merged;
  }

  private flushPendingRowFragment(chunks: string[], limit: number): void {
    if (!this.pendingRowFragment) {
      return;
    }
    const fragment = this.pendingRowFragment;
    this.pendingRowFragment = null;
    const text = this.activeTable
      ? renderTableRowAsFields(this.activeTable.cells, splitPartialTableCells(fragment))
      : renderMalformedPipeLineAsText(fragment);
    for (const chunk of this.baseChunker(text, limit)) {
      if (chunk) {
        chunks.push(chunk);
      }
    }
  }

  private flushTable(chunks: string[]): void {
    if (this.tableLines.length === 0) {
      return;
    }
    chunks.push(this.tableLines.join("\n"));
    this.tableLines = [];
  }

  private dropHeaderOnlyTableChunk(): void {
    if (
      this.activeTable &&
      this.tableLines.length === 2 &&
      this.tableLines[0] === this.activeTable.header &&
      this.tableLines[1] === this.activeTable.separator
    ) {
      this.tableLines = [];
    }
  }

  private endTable(chunks: string[]): void {
    this.flushTable(chunks);
    this.activeTable = null;
  }
}

function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && splitTableCells(trimmed).length >= 2;
}

function isIncompleteTableRowFragment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("|") && !trimmed.endsWith("|") && splitPartialTableCells(trimmed).length >= 2
  );
}

function isShortTableRowLine(line: string, table: TableHeader): boolean {
  if (!isTableRowLine(line) || isTableSeparatorLine(line)) {
    return false;
  }
  return splitTableCells(line).length < table.cells.length;
}

function isTableSeparatorLine(line: string): boolean {
  if (!isTableRowLine(line)) {
    return false;
  }
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim();
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function splitPartialTableCells(line: string): string[] {
  const trimmed = line.trim();
  return trimmed
    .replace(/^\|/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function mergeRowFragments(pending: string | null, next: string): string {
  return pending ? `${pending}${next}` : next;
}

function renderMalformedPipeLineAsText(line: string): string {
  return splitPartialTableCells(line).join(" ");
}

function renderTableRowAsFields(headers: string[], cells: string[]): string {
  return cells
    .map((cell, index) => {
      const header = headers[index]?.trim();
      return header ? `${header}: ${cell}` : cell;
    })
    .join("\n");
}

function parseFenceLine(line: string): { marker: string } | null {
  const match = line.match(/^\s*(`{3,}|~{3,})/);
  return match?.[1] ? { marker: match[1][0] ?? "" } : null;
}
