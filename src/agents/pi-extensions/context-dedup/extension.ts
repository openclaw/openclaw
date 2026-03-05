/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  deduplicateMessages,
  serializeRefTable,
  cleanOrphanedRefs,
  buildRefTableExplanation,
} from "./deduper.js";
import { getContextDedupRuntime, setContextDedupRuntime } from "./runtime.js";

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
};

type SeenChunkSource = {
  firstSeenMessageIndex: number;
  firstSeenToolCallId?: string;
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
  return block;
}

function countLines(text: string): number {
  return text.length === 0 ? 1 : text.split("\n").length;
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
  const lines = params.text.split("\n");
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
  let sourceMessageIndex: number | undefined;
  let sourceToolCallId: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const absoluteLine = start + i;
    const seen = params.seenLines.get(absoluteLine);
    if (seen && seen.text === lines[i]) {
      repeated[i] = true;
      repeatedCount++;
      if (sourceMessageIndex === undefined || seen.firstSeenMessageIndex > sourceMessageIndex) {
        sourceMessageIndex = seen.firstSeenMessageIndex;
        sourceToolCallId = seen.firstSeenToolCallId;
      }
    }
  }

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

  if (repeatedCount === lines.length && lines.length >= 8) {
    const fullSourceMessageIndex = exactChunkSource?.firstSeenMessageIndex ?? sourceMessageIndex;
    const fullSourceToolCallId = exactChunkSource?.firstSeenToolCallId ?? sourceToolCallId;
    const sourceHint = buildSourceHint(fullSourceMessageIndex, fullSourceToolCallId);

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
        sourceMessageIndex: fullSourceMessageIndex,
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

  const deltaNote = tryBuildReadDeltaNote({
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

  if (omittedLines < 8) {
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

    const content = msg.content;

    if (typeof content === "string") {
      const collapsed = collapseReadChunkAgainstSeen({
        text: content,
        path: meta.path,
        startLine: meta.offset,
        seenLines: seenLinesForPath,
        seenChunks: seenChunksForPath,
        currentMessageIndex: msgIndex,
        currentToolCallId: toolCallId,
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
    const nextContent = content.map((block) => {
      const text = extractBlockText(block);
      if (typeof text !== "string") {
        return block;
      }

      const collapsed = collapseReadChunkAgainstSeen({
        text,
        path: meta.path,
        startLine: lineCursor,
        seenLines: seenLinesForPath,
        seenChunks: seenChunksForPath,
        currentMessageIndex: msgIndex,
        currentToolCallId: toolCallId,
      });

      lineCursor += countLines(text);

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

function parseDedupPointerTarget(text: string): ParsedDedupPointerTarget | undefined {
  const match = text.match(
    /Same as context message #(\d+), block #(\d+)((?: \(toolCallId [^)]+\))?)\./,
  );
  if (!match) {
    return undefined;
  }

  const messageIndex = Number.parseInt(match[1] ?? "", 10);
  const blockIndex = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(messageIndex) || messageIndex < 0) {
    return undefined;
  }
  if (!Number.isFinite(blockIndex) || blockIndex < 0) {
    return undefined;
  }

  return {
    messageIndex,
    blockIndex,
    toolHint: typeof match[3] === "string" ? match[3] : "",
  };
}

function parseLineageSourceMessageIndex(text: string): number | undefined {
  const match = text.match(/Earlier chunk: context message #(\d+)(?: \(toolCallId [^)]+\))?/);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

const SYNTHETIC_POINTER_NOTE_HEADER =
  /^\[(?:\d+ repeats? of content omitted|Read delta from earlier chunk|Same file chunk already shown earlier|Read overlap trimmed)\]/;

function isSyntheticPointerOrLineageNote(text: string): boolean {
  if (!SYNTHETIC_POINTER_NOTE_HEADER.test(text)) {
    return false;
  }

  return (
    text.includes("Same as context message #") || text.includes("Earlier chunk: context message #")
  );
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

function resolveRootSourceMessageIndex(messages: any[], startIndex: number): number {
  let current = startIndex;
  const visited = new Set<number>();

  while (!visited.has(current) && current >= 0 && current < messages.length) {
    visited.add(current);

    const text = extractText(messages[current]?.content);
    if (typeof text !== "string" || text.length === 0) {
      return current;
    }
    if (!isSyntheticPointerOrLineageNote(text)) {
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
      currentBlockIndex = dedupTarget.blockIndex;
      currentToolHint = dedupTarget.toolHint || currentToolHint;
      continue;
    }

    const lineageTarget = parseLineageSourceMessageIndex(text);
    if (typeof lineageTarget === "number") {
      if (lineageTarget < 0 || lineageTarget >= params.messages.length) {
        break;
      }
      currentMessageIndex = lineageTarget;
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

function rewriteLineageSourceHint(text: string, messages: any[]): string {
  if (!text.includes("Earlier chunk: context message #")) {
    return text;
  }

  return text.replace(
    /Earlier chunk: context message #(\d+)(?: \(toolCallId [^)]+\))?/g,
    (full, sourceIndexRaw: string) => {
      const sourceIndex = Number.parseInt(sourceIndexRaw, 10);
      if (!Number.isFinite(sourceIndex) || sourceIndex < 0 || sourceIndex >= messages.length) {
        return full;
      }
      const resolved = resolveRootSourceMessageIndex(messages, sourceIndex);
      if (resolved === sourceIndex) {
        return full;
      }
      return `Earlier chunk: context message #${resolved}`;
    },
  );
}

function rewriteDedupPointerSourceHint(text: string, messages: any[]): string {
  if (!text.includes("Same as context message #")) {
    return text;
  }

  return text.replace(
    /Same as context message #(\d+), block #(\d+)((?: \(toolCallId [^)]+\))?)\./g,
    (full, sourceIndexRaw: string, blockIndexRaw: string, toolHintRaw: string) => {
      const sourceIndex = Number.parseInt(sourceIndexRaw, 10);
      const blockIndex = Number.parseInt(blockIndexRaw, 10);
      if (!Number.isFinite(sourceIndex) || sourceIndex < 0 || sourceIndex >= messages.length) {
        return full;
      }
      if (!Number.isFinite(blockIndex) || blockIndex < 0) {
        return full;
      }

      const toolHint = typeof toolHintRaw === "string" ? toolHintRaw : "";
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
        return full;
      }

      return `Same as context message #${resolved.messageIndex}, block #${resolved.blockIndex}${resolved.toolHint}.`;
    },
  );
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

    // Clean orphaned refs from the persistent table
    const cleanedTable = cleanOrphanedRefs(lineageMessages, runtime.refTable, runtime.settings);

    // Run deduplication on normalized messages
    const result = deduplicateMessages(lineageMessages, runtime.settings, {
      protectedMessageIndexes: lineage.protectedSourceMessageIndexes,
    });
    const resolvedMessages = rewriteReadLineageSourcePointers(result.messages);

    // Merge ref tables (new refs from this turn + cleaned old refs)
    const mergedTable = { ...cleanedTable, ...result.refTable };

    // Build candidate context: deduped messages + ref table message (if any refs)
    let candidateMessages = resolvedMessages;
    if (Object.keys(mergedTable).length > 0) {
      const refTableText = serializeRefTable(mergedTable, runtime.settings);
      const explanation = buildRefTableExplanation(runtime.settings);
      const refMessage = {
        role: "system" as const,
        content: `${explanation}${refTableText}`,
      };
      candidateMessages = [refMessage, ...resolvedMessages];
    }

    const candidateChars = contextChars(candidateMessages);

    // Safety guard: only apply dedup when it reduces context size.
    const useCandidate = candidateChars < baseChars;
    const finalMessages = useCandidate ? candidateMessages : baseMessages;

    setContextDedupRuntime(ctx.sessionManager, {
      ...runtime,
      refTable: useCandidate ? mergedTable : cleanedTable,
    });

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
        "refTable:",
        Object.keys(useCandidate ? mergedTable : cleanedTable).length,
        "readLineage:",
        `full=${lineage.stats.fullyOmittedChunks}`,
        `trimmed=${lineage.stats.partiallyTrimmedChunks}`,
        `savedChars=${lineage.stats.omittedChars}`,
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
