/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { deduplicateMessages } from "./deduper.js";
import { getContextDedupRuntime } from "./runtime.js";

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const anyPart = part as Record<string, unknown>;
          if (typeof anyPart.text === "string") {
            return anyPart.text;
          }
          if (typeof anyPart.content === "string") {
            return anyPart.content;
          }
          if (Array.isArray(anyPart.parts)) {
            return extractText(anyPart.parts);
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const anyValue = value as Record<string, unknown>;
    if (typeof anyValue.text === "string") {
      return anyValue.text;
    }
    if (typeof anyValue.content === "string") {
      return anyValue.content;
    }
    if (Array.isArray(anyValue.parts)) {
      return extractText(anyValue.parts);
    }
  }
  return "";
}

function contextChars(messages: any[]): number {
  return messages.reduce((sum, msg) => sum + extractText(msg?.content).length, 0);
}

function dumpContextToFile(messages: any[], stage: "before" | "after"): void {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join("/tmp", `context-dump-${stage}-${ts}.txt`);
    const text = messages
      .map((m, i) => {
        const body = extractText(m?.content);
        return `# ${i} role=${m?.role ?? "unknown"}\n${body}`;
      })
      .join("\n\n");
    writeFileSync(path, text, "utf8");
  } catch {
    // Never fail request flow due to debug dump write issues.
  }
}

type ReadCallMeta = {
  path: string;
  offset: number;
};

type ReadLineageStats = {
  fullyOmittedChunks: number;
  partiallyTrimmedChunks: number;
  omittedChars: number;
};

type ReadLineageCompactionResult = {
  messages: any[];
  stats: ReadLineageStats;
  protectedSourceMessageIndexes: Set<number>;
};

type SeenLine = {
  text: string;
  firstSeenMessageIndex: number;
  firstSeenToolCallId?: string;
  lastSeenMessageIndex: number;
  lastSeenToolCallId?: string;
};

type SeenChunkSource = {
  firstSeenMessageIndex: number;
  firstSeenToolCallId?: string;
};

type SeenRangeSource = {
  messageIndex: number;
  toolCallId?: string;
  startLine: number;
  endLine: number;
};

function normalizeFilePath(input: string): string {
  return input.trim().replace(/\\/g, "/");
}

function parseReadToolArgs(value: unknown): ReadCallMeta | null {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const args = raw as Record<string, unknown>;
  const pathCandidate =
    typeof args.path === "string"
      ? args.path
      : typeof args.file_path === "string"
        ? args.file_path
        : undefined;

  if (!pathCandidate || !pathCandidate.trim()) {
    return null;
  }

  const offsetRaw = typeof args.offset === "number" ? args.offset : 1;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 1;

  return {
    path: normalizeFilePath(pathCandidate),
    offset,
  };
}

const TOOL_CALL_BLOCK_TYPES = new Set(["toolcall", "tooluse", "functioncall"]);

function readToolName(call: Record<string, unknown>): string {
  if (typeof call.name === "string") {
    return call.name.toLowerCase();
  }

  const fn = call.function;
  if (fn && typeof fn === "object") {
    const fnName = (fn as Record<string, unknown>).name;
    if (typeof fnName === "string") {
      return fnName.toLowerCase();
    }
  }

  return "";
}

function readToolArguments(call: Record<string, unknown>): unknown {
  if (call.arguments !== undefined) {
    return call.arguments;
  }
  if (call.input !== undefined) {
    return call.input;
  }

  const fn = call.function;
  if (fn && typeof fn === "object") {
    const fnArgs = (fn as Record<string, unknown>).arguments;
    if (fnArgs !== undefined) {
      return fnArgs;
    }
  }

  return undefined;
}

function collectReadToolCallMeta(messages: any[]): Map<string, ReadCallMeta> {
  const byToolCallId = new Map<string, ReadCallMeta>();

  for (const msg of messages) {
    if (String(msg?.role ?? "").toLowerCase() !== "assistant") {
      continue;
    }

    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") {
        continue;
      }

      const call = block as Record<string, unknown>;
      const blockType = typeof call.type === "string" ? call.type.toLowerCase() : "";
      if (!TOOL_CALL_BLOCK_TYPES.has(blockType)) {
        continue;
      }

      const id = typeof call.id === "string" ? call.id : undefined;
      if (!id || readToolName(call) !== "read") {
        continue;
      }

      const parsed = parseReadToolArgs(readToolArguments(call));
      if (parsed && !byToolCallId.has(id)) {
        byToolCallId.set(id, parsed);
      }
    }
  }

  return byToolCallId;
}

function extractBlockText(block: unknown): string | undefined {
  if (typeof block === "string") {
    return block;
  }
  if (!block || typeof block !== "object") {
    return undefined;
  }

  const obj = block as Record<string, unknown>;
  const blockType = typeof obj.type === "string" ? obj.type.toLowerCase() : "";
  if (blockType && blockType !== "text") {
    return undefined;
  }
  if (typeof obj.text === "string") {
    return obj.text;
  }
  if (typeof obj.content === "string") {
    return obj.content;
  }
  if (Array.isArray(obj.parts)) {
    const parts = obj.parts
      .map((part) => extractBlockText(part))
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  return undefined;
}

function setBlockText(block: unknown, nextText: string): unknown {
  if (typeof block === "string") {
    return nextText;
  }
  if (!block || typeof block !== "object") {
    return block;
  }

  const obj = block as Record<string, unknown>;
  if (typeof obj.text === "string") {
    return { ...obj, text: nextText };
  }
  if (typeof obj.content === "string") {
    return { ...obj, content: nextText };
  }
  if (Array.isArray(obj.parts)) {
    return {
      ...obj,
      parts: [{ type: "text", text: nextText }],
    };
  }

  return block;
}

function splitReadLines(text: string): string[] {
  if (text.length === 0) {
    return [""];
  }

  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function countLines(text: string): number {
  return splitReadLines(text).length;
}

function hasFollowingTextBlock(blocks: unknown[], fromIndex: number): boolean {
  for (let index = fromIndex + 1; index < blocks.length; index++) {
    if (typeof extractBlockText(blocks[index]) === "string") {
      return true;
    }
  }
  return false;
}

function parseMetadataField(line: string): { key: string; value: string } | undefined {
  const match = line.match(/^([^:]+):\s*(.*)$/);
  if (!match) {
    return undefined;
  }

  const key = (match[1] ?? "").trim().toLowerCase();
  const value = (match[2] ?? "").trim();
  if (!key) {
    return undefined;
  }

  return { key, value };
}

function normalizeMetadataPathValue(value: string): string {
  const unquoted = value.replace(/^['"]|['"]$/g, "").trim();
  return normalizeFilePath(unquoted);
}

function isReadMetadataTextBlock(params: {
  text: string;
  path: string;
  hasFollowingTextBlock: boolean;
}): boolean {
  if (!params.hasFollowingTextBlock) {
    return false;
  }

  const trimmed = params.text.trim();
  if (!trimmed) {
    return true;
  }

  if (trimmed.length > 240) {
    return false;
  }

  const lines = splitReadLines(trimmed);
  if (lines.length === 0 || lines.length > 3) {
    return false;
  }

  const allowedKeys = new Set(["path", "file", "offset", "lines", "range", "line range"]);
  const fields = lines
    .map((line) => parseMetadataField(line.trim()))
    .filter((field): field is { key: string; value: string } => Boolean(field));

  if (fields.length !== lines.length) {
    return false;
  }

  if (fields.some((field) => !allowedKeys.has(field.key))) {
    return false;
  }

  const expectedPath = normalizeFilePath(params.path);
  const pathField = fields.find((field) => field.key === "path" || field.key === "file");
  if (!pathField) {
    return false;
  }

  return normalizeMetadataPathValue(pathField.value) === expectedPath;
}

function formatRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

const READ_DELTA_MAX_HUNKS = 3;
const READ_DELTA_MIN_TOTAL_LINES = 12;
const READ_DELTA_MIN_REPEATED_LINES = 8;
const READ_DELTA_MAX_COVERAGE_RATIO = 0.3;

type LineSpan = {
  start: number;
  end: number;
};

function spanLength(span: LineSpan): number {
  return span.end - span.start + 1;
}

function buildChangedSpans(repeated: boolean[]): LineSpan[] {
  const spans: LineSpan[] = [];
  let idx = 0;

  while (idx < repeated.length) {
    if (repeated[idx]) {
      idx++;
      continue;
    }

    const start = idx;
    while (idx + 1 < repeated.length && !repeated[idx + 1]) {
      idx++;
    }

    spans.push({ start, end: idx });
    idx++;
  }

  return spans;
}

function mergeSpansToLimit(spans: LineSpan[], limit: number): LineSpan[] {
  const merged = spans.map((span) => ({ ...span }));

  while (merged.length > limit) {
    let bestMergeIndex = -1;
    let smallestGap = Number.POSITIVE_INFINITY;

    for (let i = 0; i < merged.length - 1; i++) {
      const left = merged[i];
      const right = merged[i + 1];
      const gap = Math.max(0, right.start - left.end - 1);
      if (gap < smallestGap) {
        smallestGap = gap;
        bestMergeIndex = i;
      }
    }

    if (bestMergeIndex < 0) {
      break;
    }

    const left = merged[bestMergeIndex];
    const right = merged[bestMergeIndex + 1];
    merged.splice(bestMergeIndex, 2, {
      start: left.start,
      end: right.end,
    });
  }

  return merged;
}

function buildSourceHint(sourceMessageIndex?: number, sourceToolCallId?: string): string {
  if (typeof sourceMessageIndex === "number") {
    return `Earlier chunk: context message #${sourceMessageIndex}${sourceToolCallId ? ` (toolCallId ${sourceToolCallId})` : ""}`;
  }
  if (sourceToolCallId) {
    return `Earlier chunk toolCallId: ${sourceToolCallId}`;
  }
  return "Earlier chunk: prior read output";
}

function findCoveringRangeSource(
  seenRanges: SeenRangeSource[],
  startLine: number,
  endLine: number,
  minimumMessageIndex: number,
): SeenChunkSource | undefined {
  let candidate: SeenRangeSource | undefined;

  for (const seenRange of seenRanges) {
    if (seenRange.messageIndex < minimumMessageIndex) {
      continue;
    }
    if (seenRange.startLine > startLine || seenRange.endLine < endLine) {
      continue;
    }

    if (!candidate || seenRange.messageIndex > candidate.messageIndex) {
      candidate = seenRange;
    }
  }

  if (!candidate) {
    return undefined;
  }

  return {
    firstSeenMessageIndex: candidate.messageIndex,
    firstSeenToolCallId: candidate.toolCallId,
  };
}

function recordSeenRange(seenRanges: SeenRangeSource[], incoming: SeenRangeSource): void {
  for (const existing of seenRanges) {
    if (
      existing.messageIndex !== incoming.messageIndex ||
      existing.toolCallId !== incoming.toolCallId
    ) {
      continue;
    }

    if (incoming.endLine + 1 < existing.startLine || incoming.startLine > existing.endLine + 1) {
      continue;
    }

    existing.startLine = Math.min(existing.startLine, incoming.startLine);
    existing.endLine = Math.max(existing.endLine, incoming.endLine);
    return;
  }

  seenRanges.push(incoming);
}

function tryBuildReadDeltaNote(params: {
  lines: string[];
  repeated: boolean[];
  path: string;
  startLine: number;
  endLine: number;
  sourceMessageIndex?: number;
  sourceToolCallId?: string;
  originalTextLength: number;
}): string | null {
  if (params.lines.length < READ_DELTA_MIN_TOTAL_LINES) {
    return null;
  }

  const repeatedCount = params.repeated.filter(Boolean).length;
  if (repeatedCount < READ_DELTA_MIN_REPEATED_LINES) {
    return null;
  }

  const changedSpans = buildChangedSpans(params.repeated);
  if (changedSpans.length === 0) {
    return null;
  }

  const mergedSpans =
    changedSpans.length <= READ_DELTA_MAX_HUNKS
      ? changedSpans
      : mergeSpansToLimit(changedSpans, READ_DELTA_MAX_HUNKS);

  const coveredLines = mergedSpans.reduce((sum, span) => sum + spanLength(span), 0);
  const coveredRatio = coveredLines / Math.max(1, params.lines.length);
  if (coveredRatio > READ_DELTA_MAX_COVERAGE_RATIO) {
    return null;
  }

  const sourceHint = buildSourceHint(params.sourceMessageIndex, params.sourceToolCallId);
  const hunkLines = mergedSpans.map((span) => {
    const absStart = params.startLine + span.start;
    const absEnd = params.startLine + span.end;
    const nextText = params.lines.slice(span.start, span.end + 1).join("\n");

    return `- lines ${formatRange(absStart, absEnd)} now read:\n${nextText}`;
  });

  const note =
    `[Read delta from earlier chunk]\nPath: ${params.path}\n` +
    `${sourceHint}\n` +
    `Same as earlier chunk lines ${formatRange(params.startLine, params.endLine)}, except:\n` +
    hunkLines.join("\n");

  if (note.length >= params.originalTextLength) {
    return null;
  }

  return note;
}

function collapseReadChunkAgainstSeen(params: {
  text: string;
  path: string;
  startLine: number;
  seenLines: Map<number, SeenLine>;
  seenChunks: Map<string, SeenChunkSource>;
  seenRanges: SeenRangeSource[];
  currentMessageIndex: number;
  currentToolCallId?: string;
}): {
  nextText: string;
  changed: boolean;
  omittedChars: number;
  fullOmit: boolean;
  partialTrim: boolean;
  sourceMessageIndex?: number;
} {
  const lines = splitReadLines(params.text);
  const start = Math.max(1, Math.floor(params.startLine));
  const end = start + lines.length - 1;

  const chunkKey = `${start}\n${params.text}`;
  const exactChunkSource = params.seenChunks.get(chunkKey);
  if (!exactChunkSource) {
    params.seenChunks.set(chunkKey, {
      firstSeenMessageIndex: params.currentMessageIndex,
      firstSeenToolCallId: params.currentToolCallId,
    });
  }

  const repeated = Array.from({ length: lines.length }, () => false);
  let repeatedCount = 0;
  let minimumSourceMessageIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const absoluteLine = start + i;
    const seen = params.seenLines.get(absoluteLine);
    if (seen && seen.text === lines[i]) {
      repeated[i] = true;
      repeatedCount++;
      if (seen.lastSeenMessageIndex > minimumSourceMessageIndex) {
        minimumSourceMessageIndex = seen.lastSeenMessageIndex;
      }
    }
  }

  const fullRangeSource = findCoveringRangeSource(
    params.seenRanges,
    start,
    end,
    minimumSourceMessageIndex,
  );
  const sourceMessageIndex = fullRangeSource?.firstSeenMessageIndex;
  const sourceToolCallId = fullRangeSource?.firstSeenToolCallId;

  for (let i = 0; i < lines.length; i++) {
    const absoluteLine = start + i;
    const seen = params.seenLines.get(absoluteLine);
    if (seen && seen.text === lines[i]) {
      continue;
    }
    params.seenLines.set(absoluteLine, {
      text: lines[i],
      firstSeenMessageIndex: params.currentMessageIndex,
      firstSeenToolCallId: params.currentToolCallId,
      lastSeenMessageIndex: params.currentMessageIndex,
      lastSeenToolCallId: params.currentToolCallId,
    });
  }

  if (repeatedCount === 0) {
    return {
      nextText: params.text,
      changed: false,
      omittedChars: 0,
      fullOmit: false,
      partialTrim: false,
    };
  }

  if (repeatedCount === lines.length && lines.length >= 8 && exactChunkSource) {
    const sourceHint = buildSourceHint(
      exactChunkSource.firstSeenMessageIndex,
      exactChunkSource.firstSeenToolCallId,
    );

    const note =
      `[Same file chunk already shown earlier]\nPath: ${params.path}\n` +
      `${sourceHint}\n` +
      `Lines: ${formatRange(start, end)}`;

    if (note.length < params.text.length) {
      return {
        nextText: note,
        changed: true,
        omittedChars: params.text.length - note.length,
        fullOmit: true,
        partialTrim: false,
        sourceMessageIndex: exactChunkSource.firstSeenMessageIndex,
      };
    }
    return {
      nextText: params.text,
      changed: false,
      omittedChars: 0,
      fullOmit: false,
      partialTrim: false,
    };
  }

  const deltaNote =
    fullRangeSource &&
    tryBuildReadDeltaNote({
      lines,
      repeated,
      path: params.path,
      startLine: start,
      endLine: end,
      sourceMessageIndex,
      sourceToolCallId,
      originalTextLength: params.text.length,
    });

  if (deltaNote) {
    return {
      nextText: deltaNote,
      changed: true,
      omittedChars: params.text.length - deltaNote.length,
      fullOmit: false,
      partialTrim: true,
      sourceMessageIndex,
    };
  }

  const firstNovel = repeated.findIndex((value) => !value);
  const lastNovel = repeated.length - 1 - [...repeated].toReversed().findIndex((value) => !value);
  if (firstNovel < 0 || lastNovel < firstNovel) {
    return {
      nextText: params.text,
      changed: false,
      omittedChars: 0,
      fullOmit: false,
      partialTrim: false,
    };
  }

  const prefixRepeated = firstNovel;
  const suffixRepeated = lines.length - 1 - lastNovel;
  const omittedLines = prefixRepeated + suffixRepeated;

  if (omittedLines < 8 || !fullRangeSource) {
    return {
      nextText: params.text,
      changed: false,
      omittedChars: 0,
      fullOmit: false,
      partialTrim: false,
    };
  }

  const keptStart = start + firstNovel;
  const keptEnd = start + lastNovel;
  const kept = lines.slice(firstNovel, lastNovel + 1).join("\n");

  const omittedRanges: string[] = [];
  if (prefixRepeated > 0) {
    omittedRanges.push(formatRange(start, keptStart - 1));
  }
  if (suffixRepeated > 0) {
    omittedRanges.push(formatRange(keptEnd + 1, end));
  }

  const sourceHint = buildSourceHint(sourceMessageIndex, sourceToolCallId);

  const note =
    `[Read overlap trimmed]\nPath: ${params.path}\n` +
    `${sourceHint}\n` +
    `Earlier lines omitted: ${omittedRanges.join(", ")}\n` +
    `New/changed lines ${formatRange(keptStart, keptEnd)}:\n${kept}`;

  if (note.length >= params.text.length) {
    return {
      nextText: params.text,
      changed: false,
      omittedChars: 0,
      fullOmit: false,
      partialTrim: false,
    };
  }

  return {
    nextText: note,
    changed: true,
    omittedChars: params.text.length - note.length,
    fullOmit: false,
    partialTrim: true,
    sourceMessageIndex,
  };
}

export function applyReadLineageCompaction(messages: any[]): ReadLineageCompactionResult {
  const toolCallMeta = collectReadToolCallMeta(messages);
  if (toolCallMeta.size === 0) {
    return {
      messages,
      stats: {
        fullyOmittedChunks: 0,
        partiallyTrimmedChunks: 0,
        omittedChars: 0,
      },
      protectedSourceMessageIndexes: new Set<number>(),
    };
  }

  const seenLinesByPath = new Map<string, Map<number, SeenLine>>();
  const seenChunksByPath = new Map<string, Map<string, SeenChunkSource>>();
  const seenRangesByPath = new Map<string, SeenRangeSource[]>();
  let nextMessages: any[] | null = null;

  const stats: ReadLineageStats = {
    fullyOmittedChunks: 0,
    partiallyTrimmedChunks: 0,
    omittedChars: 0,
  };
  const protectedSourceMessageIndexes = new Set<number>();

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex];
    const role = String(msg?.role ?? "").toLowerCase();
    const toolName = String(msg?.toolName ?? "").toLowerCase();

    if (role !== "toolresult") {
      continue;
    }
    if (toolName && toolName !== "read") {
      continue;
    }

    const toolCallId =
      typeof msg?.toolCallId === "string"
        ? msg.toolCallId
        : typeof msg?.toolUseId === "string"
          ? msg.toolUseId
          : undefined;
    if (!toolCallId) {
      continue;
    }

    const meta = toolCallMeta.get(toolCallId);
    if (!meta) {
      continue;
    }

    let seenLines = seenLinesByPath.get(meta.path);
    if (!seenLines) {
      seenLines = new Map<number, SeenLine>();
      seenLinesByPath.set(meta.path, seenLines);
    }
    const seenLinesForPath = seenLines;

    let seenChunks = seenChunksByPath.get(meta.path);
    if (!seenChunks) {
      seenChunks = new Map<string, SeenChunkSource>();
      seenChunksByPath.set(meta.path, seenChunks);
    }
    const seenChunksForPath = seenChunks;

    let seenRanges = seenRangesByPath.get(meta.path);
    if (!seenRanges) {
      seenRanges = [];
      seenRangesByPath.set(meta.path, seenRanges);
    }
    const seenRangesForPath = seenRanges;

    const content = msg.content;

    if (typeof content === "string") {
      const lineCount = countLines(content);
      const startLine = meta.offset;
      const endLine = startLine + lineCount - 1;

      const collapsed = collapseReadChunkAgainstSeen({
        text: content,
        path: meta.path,
        startLine,
        seenLines: seenLinesForPath,
        seenChunks: seenChunksForPath,
        seenRanges: seenRangesForPath,
        currentMessageIndex: msgIndex,
        currentToolCallId: toolCallId,
      });

      recordSeenRange(seenRangesForPath, {
        messageIndex: msgIndex,
        toolCallId,
        startLine,
        endLine,
      });

      if (collapsed.changed) {
        if (!nextMessages) {
          nextMessages = messages.slice();
        }
        nextMessages[msgIndex] = { ...msg, content: collapsed.nextText };
        stats.omittedChars += collapsed.omittedChars;
        if (collapsed.fullOmit) {
          stats.fullyOmittedChunks++;
        }
        if (collapsed.partialTrim) {
          stats.partiallyTrimmedChunks++;
        }
        if (
          typeof collapsed.sourceMessageIndex === "number" &&
          collapsed.sourceMessageIndex < msgIndex
        ) {
          protectedSourceMessageIndexes.add(collapsed.sourceMessageIndex);
        }
      }

      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    let lineCursor = meta.offset;
    let messageChanged = false;
    const nextContent = content.map((block, blockIndex, allBlocks) => {
      const text = extractBlockText(block);
      if (typeof text !== "string") {
        return block;
      }

      const metadataBlock = isReadMetadataTextBlock({
        text,
        path: meta.path,
        hasFollowingTextBlock: hasFollowingTextBlock(allBlocks, blockIndex),
      });
      if (metadataBlock) {
        return block;
      }

      const lineCount = countLines(text);
      const startLine = lineCursor;
      const endLine = startLine + lineCount - 1;

      const collapsed = collapseReadChunkAgainstSeen({
        text,
        path: meta.path,
        startLine,
        seenLines: seenLinesForPath,
        seenChunks: seenChunksForPath,
        seenRanges: seenRangesForPath,
        currentMessageIndex: msgIndex,
        currentToolCallId: toolCallId,
      });

      lineCursor += lineCount;

      recordSeenRange(seenRangesForPath, {
        messageIndex: msgIndex,
        toolCallId,
        startLine,
        endLine,
      });

      if (!collapsed.changed) {
        return block;
      }

      messageChanged = true;
      stats.omittedChars += collapsed.omittedChars;
      if (collapsed.fullOmit) {
        stats.fullyOmittedChunks++;
      }
      if (collapsed.partialTrim) {
        stats.partiallyTrimmedChunks++;
      }
      if (
        typeof collapsed.sourceMessageIndex === "number" &&
        collapsed.sourceMessageIndex < msgIndex
      ) {
        protectedSourceMessageIndexes.add(collapsed.sourceMessageIndex);
      }

      return setBlockText(block, collapsed.nextText);
    });

    if (messageChanged) {
      if (!nextMessages) {
        nextMessages = messages.slice();
      }
      nextMessages[msgIndex] = {
        ...msg,
        content: nextContent,
      };
    }
  }

  return {
    messages: nextMessages ?? messages,
    stats,
    protectedSourceMessageIndexes,
  };
}

type ParsedDedupPointerTarget = {
  messageIndex: number;
  blockIndex: number;
  toolHint: string;
};

const SOURCE_HINT_HEADER_SCAN_LIMIT = 4;

function forEachSyntheticHeaderLine(text: string, visitor: (line: string) => boolean): void {
  const lines = text.split("\n");
  const headerLimit = Math.min(lines.length, SOURCE_HINT_HEADER_SCAN_LIMIT);

  for (let index = 0; index < headerLimit; index++) {
    const line = (lines[index] ?? "").trim();
    if (!line) {
      continue;
    }
    if (visitor(line)) {
      return;
    }
  }
}

function parseDedupPointerTarget(text: string): ParsedDedupPointerTarget | undefined {
  let parsed: ParsedDedupPointerTarget | undefined;

  forEachSyntheticHeaderLine(text, (line) => {
    const match = line.match(
      /^Same as context message #(\d+), block #(\d+)((?: \(toolCallId [^)]+\))?)\.(?:\s.*)?$/,
    );
    if (!match) {
      return false;
    }

    const messageIndex = Number.parseInt(match[1] ?? "", 10);
    const blockIndex = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(messageIndex) || messageIndex < 0) {
      return false;
    }
    if (!Number.isFinite(blockIndex) || blockIndex < 0) {
      return false;
    }

    parsed = {
      messageIndex,
      blockIndex,
      toolHint: typeof match[3] === "string" ? match[3] : "",
    };
    return true;
  });

  return parsed;
}

function parseLineageSourceMessageIndex(text: string): number | undefined {
  let parsed: number | undefined;

  forEachSyntheticHeaderLine(text, (line) => {
    const match = line.match(/^Earlier chunk: context message #(\d+)(?: \(toolCallId [^)]+\))?$/);
    if (!match) {
      return false;
    }

    const value = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(value) || value < 0) {
      return false;
    }

    parsed = value;
    return true;
  });

  return parsed;
}

const SYNTHETIC_POINTER_NOTE_HEADER =
  /^\[(?:\d+ repeats? of content omitted|Near-duplicate content trimmed|Read delta from earlier chunk|Same file chunk already shown earlier|Read overlap trimmed)\]/;

function isSyntheticPointerOrLineageNote(text: string): boolean {
  if (!SYNTHETIC_POINTER_NOTE_HEADER.test(text)) {
    return false;
  }

  return (
    text.includes("Same as context message #") || text.includes("Earlier chunk: context message #")
  );
}

type RepeatFoldStats = {
  collapsedRuns: number;
  omittedCopies: number;
  omittedChars: number;
};

type RepeatFoldResult = {
  messages: any[];
  stats: RepeatFoldStats;
};

type RepeatFoldOptions = {
  protectedMessageIndexes?: Set<number>;
};

const REPEAT_FOLD_MARKER_REGEX = /\[repeats \d+ more times\]/i;
const REPEAT_FOLD_MIN_UNIT_CHARS = 24;
const REPEAT_FOLD_MAX_PATTERN_UNITS = 32;
const REPEAT_FOLD_RAW_MAX_TEXT_CHARS = 16_000;
const REPEAT_FOLD_RAW_MIN_PATTERN_CHARS = 24;
const REPEAT_FOLD_RAW_MAX_PATTERN_CHARS = 320;
const REPEAT_FOLD_RAW_MIN_SAVED_CHARS = 24;
const ANSI_ESCAPE_SEQUENCE_REGEX = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, "g");

function createEmptyRepeatFoldStats(): RepeatFoldStats {
  return {
    collapsedRuns: 0,
    omittedCopies: 0,
    omittedChars: 0,
  };
}

type RepeatFoldCanonicalizer = (unit: string) => string;

function normalizeWhitespaceForRepeatMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeTerminalFrameForRepeatMatch(text: string): string {
  return normalizeWhitespaceForRepeatMatch(
    text
      .replace(ANSI_ESCAPE_SEQUENCE_REGEX, " ")
      .replace(/\[(?:\d+;)*\d+m/g, " ")
      .replace(/\[\d+G\[J/g, " ")
      .replace(/[◐◑◒◓]/g, "<spin>")
      .replace(/\.{2,}/g, "."),
  );
}

function foldContiguousRepeatedUnitPatterns(
  units: string[],
  joiner: string,
  canonicalizer: RepeatFoldCanonicalizer = normalizeWhitespaceForRepeatMatch,
): {
  text: string;
  changed: boolean;
  stats: RepeatFoldStats;
} {
  const originalText = units.join(joiner);
  if (units.length < 2) {
    return {
      text: originalText,
      changed: false,
      stats: createEmptyRepeatFoldStats(),
    };
  }

  const canonicalUnits = units.map((unit) => canonicalizer(unit));
  const output: string[] = [];
  const stats = createEmptyRepeatFoldStats();

  let idx = 0;
  while (idx < units.length) {
    let best:
      | {
          patternUnits: number;
          repeats: number;
          collapsedText: string;
          savedChars: number;
        }
      | undefined;

    const remaining = units.length - idx;
    const maxPatternUnits = Math.min(REPEAT_FOLD_MAX_PATTERN_UNITS, Math.floor(remaining / 2));

    for (let patternUnits = 1; patternUnits <= maxPatternUnits; patternUnits++) {
      const patternEnd = idx + patternUnits;

      const patternCanonical = canonicalUnits.slice(idx, patternEnd);
      if (patternCanonical.some((value) => !value || value.length === 0)) {
        continue;
      }
      if (units.slice(idx, patternEnd).some((unit) => REPEAT_FOLD_MARKER_REGEX.test(unit))) {
        continue;
      }

      const patternCanonicalChars = patternCanonical.reduce((sum, value) => sum + value.length, 0);
      if (patternCanonicalChars < REPEAT_FOLD_MIN_UNIT_CHARS) {
        continue;
      }

      let immediateMatch = true;
      for (let unitOffset = 0; unitOffset < patternUnits; unitOffset++) {
        if (canonicalUnits[idx + unitOffset] !== canonicalUnits[idx + patternUnits + unitOffset]) {
          immediateMatch = false;
          break;
        }
      }
      if (!immediateMatch) {
        continue;
      }

      let repeats = 2;
      while (idx + (repeats + 1) * patternUnits <= units.length) {
        let matches = true;
        const compareBase = idx + repeats * patternUnits;
        for (let unitOffset = 0; unitOffset < patternUnits; unitOffset++) {
          if (canonicalUnits[idx + unitOffset] !== canonicalUnits[compareBase + unitOffset]) {
            matches = false;
            break;
          }
        }
        if (!matches) {
          break;
        }
        repeats++;
      }

      const patternText = units.slice(idx, patternEnd).join(joiner).trimEnd();
      const originalRunText = units.slice(idx, idx + repeats * patternUnits).join(joiner);
      const collapsedText = `${patternText} [repeats ${repeats - 1} more times]`;
      const savedChars = originalRunText.length - collapsedText.length;
      if (savedChars <= 0) {
        continue;
      }

      if (!best || savedChars > best.savedChars) {
        best = {
          patternUnits,
          repeats,
          collapsedText,
          savedChars,
        };
      }
    }

    if (!best) {
      output.push(units[idx]);
      idx++;
      continue;
    }

    output.push(best.collapsedText);
    stats.collapsedRuns += 1;
    stats.omittedCopies += best.repeats - 1;
    stats.omittedChars += best.savedChars;
    idx += best.patternUnits * best.repeats;
  }

  const nextText = output.join(joiner);
  return {
    text: nextText,
    changed: nextText !== originalText,
    stats,
  };
}

function splitTerminalProgressFrames(text: string): string[] {
  if (!/\[\d+G\[J/.test(text)) {
    return [];
  }

  const frames = text
    .split(/(?=\[\d+G\[J)/g)
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0);

  if (frames.length < 2) {
    return [];
  }

  return frames;
}

function splitSentenceLikeUnits(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length <= 1) {
    return [];
  }

  return parts;
}

function foldRawRepeatedCharacterPatterns(text: string): {
  text: string;
  changed: boolean;
  stats: RepeatFoldStats;
} {
  if (
    text.length < REPEAT_FOLD_RAW_MIN_PATTERN_CHARS * 2 ||
    text.length > REPEAT_FOLD_RAW_MAX_TEXT_CHARS
  ) {
    return {
      text,
      changed: false,
      stats: createEmptyRepeatFoldStats(),
    };
  }

  const outputSegments: string[] = [];
  const stats = createEmptyRepeatFoldStats();

  let cursor = 0;
  let idx = 0;

  while (idx < text.length - REPEAT_FOLD_RAW_MIN_PATTERN_CHARS * 2) {
    let best:
      | {
          patternLength: number;
          repeats: number;
          collapsedText: string;
          savedChars: number;
        }
      | undefined;

    const remaining = text.length - idx;
    const maxPatternLength = Math.min(REPEAT_FOLD_RAW_MAX_PATTERN_CHARS, Math.floor(remaining / 2));

    for (
      let patternLength = REPEAT_FOLD_RAW_MIN_PATTERN_CHARS;
      patternLength <= maxPatternLength;
      patternLength++
    ) {
      const pattern = text.slice(idx, idx + patternLength);
      if (REPEAT_FOLD_MARKER_REGEX.test(pattern)) {
        continue;
      }

      if (text.slice(idx + patternLength, idx + patternLength * 2) !== pattern) {
        continue;
      }

      let repeats = 2;
      while (idx + (repeats + 1) * patternLength <= text.length) {
        const nextChunkStart = idx + repeats * patternLength;
        const nextChunkEnd = nextChunkStart + patternLength;
        if (text.slice(nextChunkStart, nextChunkEnd) !== pattern) {
          break;
        }
        repeats++;
      }

      const collapsedText = `${pattern.trimEnd()} [repeats ${repeats - 1} more times]`;
      const savedChars = patternLength * repeats - collapsedText.length;
      if (savedChars < REPEAT_FOLD_RAW_MIN_SAVED_CHARS) {
        continue;
      }

      if (!best || savedChars > best.savedChars) {
        best = {
          patternLength,
          repeats,
          collapsedText,
          savedChars,
        };
      }
    }

    if (!best) {
      idx++;
      continue;
    }

    if (cursor < idx) {
      outputSegments.push(text.slice(cursor, idx));
    }

    outputSegments.push(best.collapsedText);
    stats.collapsedRuns += 1;
    stats.omittedCopies += best.repeats - 1;
    stats.omittedChars += best.savedChars;

    idx += best.patternLength * best.repeats;
    cursor = idx;
  }

  if (stats.collapsedRuns === 0) {
    return {
      text,
      changed: false,
      stats,
    };
  }

  if (cursor < text.length) {
    outputSegments.push(text.slice(cursor));
  }

  const nextText = outputSegments.join("");
  return {
    text: nextText,
    changed: nextText !== text,
    stats,
  };
}

function foldSingleLineRepeatedTextRuns(text: string): {
  text: string;
  changed: boolean;
  stats: RepeatFoldStats;
} {
  let bestFold: {
    text: string;
    changed: boolean;
    stats: RepeatFoldStats;
  } = {
    text,
    changed: false,
    stats: createEmptyRepeatFoldStats(),
  };

  const terminalFrames = splitTerminalProgressFrames(text);
  if (terminalFrames.length >= 2) {
    const terminalFold = foldContiguousRepeatedUnitPatterns(
      terminalFrames,
      "",
      normalizeTerminalFrameForRepeatMatch,
    );
    if (terminalFold.changed && terminalFold.stats.omittedChars > bestFold.stats.omittedChars) {
      bestFold = {
        text: terminalFold.text,
        changed: true,
        stats: terminalFold.stats,
      };
    }
  }

  const sentenceUnits = splitSentenceLikeUnits(text);
  if (sentenceUnits.length >= 2) {
    const sentencePatternFold = foldContiguousRepeatedUnitPatterns(sentenceUnits, " ");
    if (
      sentencePatternFold.changed &&
      sentencePatternFold.stats.omittedChars > bestFold.stats.omittedChars
    ) {
      bestFold = {
        text: sentencePatternFold.text,
        changed: true,
        stats: sentencePatternFold.stats,
      };
    }
  }

  const rawFold = foldRawRepeatedCharacterPatterns(text);
  if (rawFold.changed && rawFold.stats.omittedChars > bestFold.stats.omittedChars) {
    bestFold = rawFold;
  }

  return bestFold;
}

function foldRepeatedTextRuns(text: string): {
  text: string;
  changed: boolean;
  stats: RepeatFoldStats;
} {
  if (!text.trim() || isSyntheticPointerOrLineageNote(text)) {
    return {
      text,
      changed: false,
      stats: createEmptyRepeatFoldStats(),
    };
  }

  let workingText = text;
  const combinedStats = createEmptyRepeatFoldStats();
  let changed = false;

  const linePatternFold = foldContiguousRepeatedUnitPatterns(
    workingText.split("\n"),
    "\n",
    (unit) => unit,
  );
  if (linePatternFold.changed) {
    workingText = linePatternFold.text;
    changed = true;
    combinedStats.collapsedRuns += linePatternFold.stats.collapsedRuns;
    combinedStats.omittedCopies += linePatternFold.stats.omittedCopies;
    combinedStats.omittedChars += linePatternFold.stats.omittedChars;
  }

  if (!workingText.includes("\n")) {
    const singleLineFold = foldSingleLineRepeatedTextRuns(workingText);
    if (singleLineFold.changed) {
      workingText = singleLineFold.text;
      changed = true;
      combinedStats.collapsedRuns += singleLineFold.stats.collapsedRuns;
      combinedStats.omittedCopies += singleLineFold.stats.omittedCopies;
      combinedStats.omittedChars += singleLineFold.stats.omittedChars;
    }

    return {
      text: workingText,
      changed,
      stats: changed ? combinedStats : createEmptyRepeatFoldStats(),
    };
  }

  // For multiline tool output, still fold repeated terminal/raw runs within each line.
  // This catches spinner/progress blobs embedded in otherwise newline-rich payloads.
  const lineParts = workingText.split(/(\r?\n)/);

  for (let i = 0; i < lineParts.length; i += 2) {
    const line = lineParts[i] ?? "";
    if (line.length < REPEAT_FOLD_MIN_UNIT_CHARS * 2) {
      continue;
    }

    const foldedLine = foldSingleLineRepeatedTextRuns(line);
    if (!foldedLine.changed) {
      continue;
    }

    lineParts[i] = foldedLine.text;
    changed = true;
    combinedStats.collapsedRuns += foldedLine.stats.collapsedRuns;
    combinedStats.omittedCopies += foldedLine.stats.omittedCopies;
    combinedStats.omittedChars += foldedLine.stats.omittedChars;
  }

  return {
    text: changed ? lineParts.join("") : text,
    changed,
    stats: changed ? combinedStats : createEmptyRepeatFoldStats(),
  };
}

function isRepeatFoldEligibleMessage(msg: any): boolean {
  const role = String(msg?.role ?? "").toLowerCase();
  return role === "tool" || role === "toolresult";
}

export function applyRepeatFoldCompaction(
  messages: any[],
  options: RepeatFoldOptions = {},
): RepeatFoldResult {
  let nextMessages: any[] | null = null;
  const stats: RepeatFoldStats = {
    collapsedRuns: 0,
    omittedCopies: 0,
    omittedChars: 0,
  };
  const protectedMessageIndexes = options.protectedMessageIndexes ?? new Set<number>();

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex];
    if (!isRepeatFoldEligibleMessage(msg)) {
      continue;
    }
    if (protectedMessageIndexes.has(msgIndex)) {
      continue;
    }

    const content = msg?.content;

    if (typeof content === "string") {
      const folded = foldRepeatedTextRuns(content);
      if (!folded.changed) {
        continue;
      }

      if (!nextMessages) {
        nextMessages = messages.slice();
      }
      nextMessages[msgIndex] = {
        ...msg,
        content: folded.text,
      };
      stats.collapsedRuns += folded.stats.collapsedRuns;
      stats.omittedCopies += folded.stats.omittedCopies;
      stats.omittedChars += folded.stats.omittedChars;
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    let messageChanged = false;
    const nextContent = content.map((block) => {
      const blockText = extractBlockText(block);
      if (typeof blockText !== "string") {
        return block;
      }

      const folded = foldRepeatedTextRuns(blockText);
      if (!folded.changed) {
        return block;
      }

      messageChanged = true;
      stats.collapsedRuns += folded.stats.collapsedRuns;
      stats.omittedCopies += folded.stats.omittedCopies;
      stats.omittedChars += folded.stats.omittedChars;
      return setBlockText(block, folded.text);
    });

    if (!messageChanged) {
      continue;
    }

    if (!nextMessages) {
      nextMessages = messages.slice();
    }
    nextMessages[msgIndex] = {
      ...msg,
      content: nextContent,
    };
  }

  return {
    messages: nextMessages ?? messages,
    stats,
  };
}

function extractMessageBlockText(message: any, blockIndex: number): string | undefined {
  const content = message?.content;

  if (typeof content === "string") {
    return blockIndex === 0 ? content : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  if (blockIndex < 0 || blockIndex >= content.length) {
    return undefined;
  }

  return extractBlockText(content[blockIndex]);
}

function findSyntheticPointerTextInMessage(message: any): string | undefined {
  const content = message?.content;

  if (typeof content === "string") {
    return isSyntheticPointerOrLineageNote(content) ? content : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const block of content) {
    const text = extractBlockText(block);
    if (typeof text === "string" && isSyntheticPointerOrLineageNote(text)) {
      return text;
    }
  }

  return undefined;
}

function clampBlockIndexForMessage(message: any, desiredBlockIndex: number): number {
  const content = message?.content;

  if (typeof content === "string") {
    return 0;
  }

  if (!Array.isArray(content)) {
    return 0;
  }

  if (desiredBlockIndex < 0 || desiredBlockIndex >= content.length) {
    return 0;
  }

  return desiredBlockIndex;
}

function resolveRootSourceMessageIndex(messages: any[], startIndex: number): number {
  let current = startIndex;
  const visited = new Set<number>();

  while (!visited.has(current) && current >= 0 && current < messages.length) {
    visited.add(current);

    const text = findSyntheticPointerTextInMessage(messages[current]);
    if (typeof text !== "string" || text.length === 0) {
      return current;
    }

    const dedupTarget = parseDedupPointerTarget(text);
    if (dedupTarget) {
      if (dedupTarget.messageIndex < 0 || dedupTarget.messageIndex >= messages.length) {
        return current;
      }
      current = dedupTarget.messageIndex;
      continue;
    }

    const lineageTarget = parseLineageSourceMessageIndex(text);
    if (typeof lineageTarget === "number") {
      if (lineageTarget < 0 || lineageTarget >= messages.length) {
        return current;
      }
      current = lineageTarget;
      continue;
    }

    return current;
  }

  return startIndex;
}

function resolveRootDedupPointerTarget(params: {
  messages: any[];
  sourceMessageIndex: number;
  sourceBlockIndex: number;
  sourceToolHint: string;
}): ParsedDedupPointerTarget {
  let currentMessageIndex = params.sourceMessageIndex;
  let currentBlockIndex = params.sourceBlockIndex;
  let currentToolHint = params.sourceToolHint;

  const visited = new Set<string>();

  while (currentMessageIndex >= 0 && currentMessageIndex < params.messages.length) {
    const visitedKey = `${currentMessageIndex}:${currentBlockIndex}`;
    if (visited.has(visitedKey)) {
      break;
    }
    visited.add(visitedKey);

    const text = extractMessageBlockText(params.messages[currentMessageIndex], currentBlockIndex);
    if (typeof text !== "string" || text.length === 0) {
      break;
    }
    if (!isSyntheticPointerOrLineageNote(text)) {
      break;
    }

    const dedupTarget = parseDedupPointerTarget(text);
    if (dedupTarget) {
      if (dedupTarget.messageIndex < 0 || dedupTarget.messageIndex >= params.messages.length) {
        break;
      }
      currentMessageIndex = dedupTarget.messageIndex;
      currentBlockIndex = clampBlockIndexForMessage(
        params.messages[currentMessageIndex],
        dedupTarget.blockIndex,
      );
      currentToolHint = dedupTarget.toolHint || currentToolHint;
      continue;
    }

    const lineageTarget = parseLineageSourceMessageIndex(text);
    if (typeof lineageTarget === "number") {
      if (lineageTarget < 0 || lineageTarget >= params.messages.length) {
        break;
      }
      currentMessageIndex = lineageTarget;
      currentBlockIndex = clampBlockIndexForMessage(
        params.messages[currentMessageIndex],
        currentBlockIndex,
      );
      continue;
    }

    break;
  }

  return {
    messageIndex: currentMessageIndex,
    blockIndex: currentBlockIndex,
    toolHint: currentToolHint,
  };
}

function rewriteSyntheticHeaderLines(text: string, lineRewriter: (line: string) => string): string {
  const lines = text.split("\n");
  const headerLimit = Math.min(lines.length, SOURCE_HINT_HEADER_SCAN_LIMIT);

  let changed = false;
  for (let index = 0; index < headerLimit; index++) {
    const current = lines[index] ?? "";
    const rewritten = lineRewriter(current);
    if (rewritten === current) {
      continue;
    }
    lines[index] = rewritten;
    changed = true;
  }

  return changed ? lines.join("\n") : text;
}

function rewriteLineageSourceHint(text: string, messages: any[]): string {
  if (!text.includes("Earlier chunk: context message #")) {
    return text;
  }

  return rewriteSyntheticHeaderLines(text, (line) => {
    const match = line.match(
      /^(Earlier chunk: context message #)(\d+)(?: \(toolCallId [^)]+\))?(.*)$/,
    );
    if (!match) {
      return line;
    }

    const sourceIndex = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(sourceIndex) || sourceIndex < 0 || sourceIndex >= messages.length) {
      return line;
    }

    const resolved = resolveRootSourceMessageIndex(messages, sourceIndex);
    if (resolved === sourceIndex) {
      return line;
    }

    const suffix = typeof match[3] === "string" ? match[3] : "";
    return `Earlier chunk: context message #${resolved}${suffix}`;
  });
}

function rewriteDedupPointerSourceHint(text: string, messages: any[]): string {
  if (!text.includes("Same as context message #")) {
    return text;
  }

  return rewriteSyntheticHeaderLines(text, (line) => {
    const match = line.match(
      /^(Same as context message #)(\d+), block #(\d+)((?: \(toolCallId [^)]+\))?)\.(.*)$/,
    );
    if (!match) {
      return line;
    }

    const sourceIndex = Number.parseInt(match[2] ?? "", 10);
    const blockIndex = Number.parseInt(match[3] ?? "", 10);
    if (!Number.isFinite(sourceIndex) || sourceIndex < 0 || sourceIndex >= messages.length) {
      return line;
    }
    if (!Number.isFinite(blockIndex) || blockIndex < 0) {
      return line;
    }

    const toolHint = typeof match[4] === "string" ? match[4] : "";
    const resolved = resolveRootDedupPointerTarget({
      messages,
      sourceMessageIndex: sourceIndex,
      sourceBlockIndex: blockIndex,
      sourceToolHint: toolHint,
    });
    if (
      resolved.messageIndex === sourceIndex &&
      resolved.blockIndex === blockIndex &&
      resolved.toolHint === toolHint
    ) {
      return line;
    }

    const suffix = typeof match[5] === "string" ? match[5] : "";
    return `Same as context message #${resolved.messageIndex}, block #${resolved.blockIndex}${resolved.toolHint}.${suffix}`;
  });
}

export function rewriteReadLineageSourcePointers(messages: any[]): any[] {
  let nextMessages: any[] | null = null;

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex];
    const content = msg?.content;

    if (typeof content === "string") {
      if (!isSyntheticPointerOrLineageNote(content)) {
        continue;
      }

      const rewritten = rewriteDedupPointerSourceHint(
        rewriteLineageSourceHint(content, messages),
        messages,
      );
      if (rewritten !== content) {
        if (!nextMessages) {
          nextMessages = messages.slice();
        }
        nextMessages[msgIndex] = { ...msg, content: rewritten };
      }
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    let changed = false;
    const nextContent = content.map((block) => {
      const text = extractBlockText(block);
      if (typeof text !== "string") {
        return block;
      }
      if (!isSyntheticPointerOrLineageNote(text)) {
        return block;
      }

      const rewritten = rewriteDedupPointerSourceHint(
        rewriteLineageSourceHint(text, messages),
        messages,
      );
      if (rewritten === text) {
        return block;
      }

      changed = true;
      return setBlockText(block, rewritten);
    });

    if (changed) {
      if (!nextMessages) {
        nextMessages = messages.slice();
      }
      nextMessages[msgIndex] = { ...msg, content: nextContent };
    }
  }

  return nextMessages ?? messages;
}

export default function contextDedupExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextDedupRuntime(ctx.sessionManager);

    // Skip if not configured
    if (!runtime || runtime.settings.mode === "off") {
      return undefined;
    }

    const baseMessages = event.messages as any[];
    const baseChars = contextChars(baseMessages);

    if (runtime.settings.debugDump) {
      dumpContextToFile(baseMessages, "before");
    }

    const lineage = applyReadLineageCompaction(baseMessages);
    const lineageMessages = lineage.messages;

    // Run deduplication on normalized messages
    const result = deduplicateMessages(lineageMessages, runtime.settings, {
      protectedMessageIndexes: lineage.protectedSourceMessageIndexes,
    });
    const resolvedMessages = rewriteReadLineageSourcePointers(result.messages);
    const repeatFold = applyRepeatFoldCompaction(resolvedMessages, {
      protectedMessageIndexes: lineage.protectedSourceMessageIndexes,
    });

    const candidateMessages = repeatFold.messages;
    const candidateChars = contextChars(candidateMessages);

    // Safety guard: only apply dedup when it reduces context size.
    const useCandidate = candidateChars < baseChars;
    const finalMessages = useCandidate ? candidateMessages : baseMessages;

    if (runtime.settings.debugDump) {
      console.log(
        "[DEDUP DEBUG] Context:",
        baseMessages.length,
        "messages,",
        baseChars,
        "chars ->",
        candidateChars,
        "chars,",
        useCandidate ? "dedup applied" : "dedup skipped (no net savings)",
        "readLineage:",
        `full=${lineage.stats.fullyOmittedChunks}`,
        `trimmed=${lineage.stats.partiallyTrimmedChunks}`,
        `savedChars=${lineage.stats.omittedChars}`,
        "repeatFold:",
        `runs=${repeatFold.stats.collapsedRuns}`,
        `copies=${repeatFold.stats.omittedCopies}`,
        `savedChars=${repeatFold.stats.omittedChars}`,
      );
    }

    if (runtime.settings.debugDump) {
      dumpContextToFile(finalMessages, "after");
    }

    // Returning undefined keeps original messages untouched.
    if (!useCandidate) {
      return undefined;
    }

    return { messages: finalMessages };
  });
}
