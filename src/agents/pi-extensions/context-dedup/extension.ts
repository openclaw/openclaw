import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { deduplicateMessages, serializeRefTable, cleanOrphanedRefs, buildRefTableExplanation } from "./deduper.js";
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

type SeenLine = {
  text: string;
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
      if (call.type !== "toolCall") {
        continue;
      }

      const id = typeof call.id === "string" ? call.id : undefined;
      const toolName = typeof call.name === "string" ? call.name.toLowerCase() : "";
      if (!id || toolName !== "read") {
        continue;
      }

      const parsed = parseReadToolArgs(call.arguments);
      if (parsed) {
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

function collapseReadChunkAgainstSeen(params: {
  text: string;
  path: string;
  startLine: number;
  seenLines: Map<number, SeenLine>;
  currentMessageIndex: number;
  currentToolCallId?: string;
}): {
  nextText: string;
  changed: boolean;
  omittedChars: number;
  fullOmit: boolean;
  partialTrim: boolean;
} {
  const lines = params.text.split("\n");
  const start = Math.max(1, Math.floor(params.startLine));
  const end = start + lines.length - 1;

  const repeated = new Array<boolean>(lines.length).fill(false);
  let repeatedCount = 0;
  let sourceMessageIndex: number | undefined;
  let sourceToolCallId: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const absoluteLine = start + i;
    const seen = params.seenLines.get(absoluteLine);
    if (seen && seen.text === lines[i]) {
      repeated[i] = true;
      repeatedCount++;
      if (
        sourceMessageIndex === undefined ||
        seen.firstSeenMessageIndex < sourceMessageIndex
      ) {
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
    const sourceHint =
      typeof sourceMessageIndex === "number"
        ? `Earlier chunk: context message #${sourceMessageIndex}${sourceToolCallId ? ` (toolCallId ${sourceToolCallId})` : ""}`
        : sourceToolCallId
          ? `Earlier chunk toolCallId: ${sourceToolCallId}`
          : "Earlier chunk: prior read output";

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

  const firstNovel = repeated.findIndex((value) => !value);
  const lastNovel = repeated.length - 1 - [...repeated].reverse().findIndex((value) => !value);
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

  const sourceHint =
    typeof sourceMessageIndex === "number"
      ? `Earlier chunk: context message #${sourceMessageIndex}${sourceToolCallId ? ` (toolCallId ${sourceToolCallId})` : ""}`
      : sourceToolCallId
        ? `Earlier chunk toolCallId: ${sourceToolCallId}`
        : "Earlier chunk: prior read output";

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
  };
}

function applyReadLineageCompaction(messages: any[]): { messages: any[]; stats: ReadLineageStats } {
  const toolCallMeta = collectReadToolCallMeta(messages);
  if (toolCallMeta.size === 0) {
    return {
      messages,
      stats: {
        fullyOmittedChunks: 0,
        partiallyTrimmedChunks: 0,
        omittedChars: 0,
      },
    };
  }

  const seenLinesByPath = new Map<string, Map<number, SeenLine>>();
  let nextMessages: any[] | null = null;

  const stats: ReadLineageStats = {
    fullyOmittedChunks: 0,
    partiallyTrimmedChunks: 0,
    omittedChars: 0,
  };

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex];
    const role = String(msg?.role ?? "").toLowerCase();
    const toolName = String(msg?.toolName ?? "").toLowerCase();

    if (role !== "toolresult" || toolName !== "read") {
      continue;
    }

    const toolCallId = typeof msg?.toolCallId === "string" ? msg.toolCallId : undefined;
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

    const content = msg.content;

    if (typeof content === "string") {
      const collapsed = collapseReadChunkAgainstSeen({
        text: content,
        path: meta.path,
        startLine: meta.offset,
        seenLines: seenLinesForPath,
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
  };
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
    const result = deduplicateMessages(lineageMessages, runtime.settings);

    // Merge ref tables (new refs from this turn + cleaned old refs)
    const mergedTable = { ...cleanedTable, ...result.refTable };

    // Build candidate context: deduped messages + ref table message (if any refs)
    let candidateMessages = result.messages;
    if (Object.keys(mergedTable).length > 0) {
      const refTableText = serializeRefTable(mergedTable, runtime.settings);
      const explanation = buildRefTableExplanation(runtime.settings);
      const refMessage = {
        role: "system" as const,
        content: `${explanation}${refTableText}`,
      };
      candidateMessages = [refMessage, ...result.messages];
    }

    const candidateChars = contextChars(candidateMessages);

    // Safety guard: only apply dedup when it reduces context size.
    const useCandidate = candidateChars < baseChars;
    const finalMessages = useCandidate ? candidateMessages : baseMessages;

    setContextDedupRuntime(ctx.sessionManager, {
      ...runtime,
      refTable: useCandidate ? mergedTable : cleanedTable,
    });

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
