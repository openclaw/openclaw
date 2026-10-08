import { truncateNativeToolTranscriptText } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  inferToolMetaFromArgs,
  projectAgentToolActivity,
  type ToolProgressDetailMode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  itemName,
  itemStatus,
  auditNativeToolName,
  unknownItemStatus,
  isProjectedNativeToolItem,
} from "./event-projector-items.js";
import { collectDynamicToolContentText } from "./event-projector-tool-output.js";
import { isJsonObject, type CodexThreadItem, type JsonObject } from "./protocol.js";
import {
  sanitizeCodexAgentEventRecord,
  sanitizeCodexToolArguments,
} from "./tool-progress-normalization.js";
import { projectCodexWebSearchItem } from "./web-search-item.js";

export function readInterceptedNativePatchInput(
  command: unknown,
): { input: string; cwd?: string } | undefined {
  if (typeof command !== "string") {
    return undefined;
  }
  const lines = command.replace(/\r\n?/gu, "\n").split("\n");
  const patchStart = lines.indexOf("*** Begin Patch");
  // Nested heredocs and shell expansion can hide extra commands. Trust only
  // a top-level patch, an inert cd, and a single-quoted matching delimiter.
  const invocation =
    /^[\t ]*(?:cd[\t ]+(?:'([^'\n]+)'|([A-Za-z0-9_./-]+))[\t ]+&&[\t ]+)?apply_patch[\t ]*<<-?[\t ]*'([^'\n]+)'[\t ]*$/u.exec(
      lines[0] ?? "",
    );
  if (!invocation || patchStart !== 1) {
    return undefined;
  }
  const patchEnd = lines.indexOf("*** End Patch", patchStart + 1);
  const cwd = invocation[1] ?? invocation[2];
  const delimiter = invocation[3];
  if (
    patchEnd < 0 ||
    lines[patchEnd + 1] !== delimiter ||
    lines.slice(patchEnd + 2).some((line) => line.trim().length > 0)
  ) {
    return undefined;
  }
  return {
    input: `${lines.slice(patchStart, patchEnd + 1).join("\n")}\n`,
    ...(cwd ? { cwd } : {}),
  };
}

export function projectCodexToolActivity(
  item: CodexThreadItem,
  phase: "start" | "result",
  meta?: string,
) {
  const name = itemName(item) ?? auditNativeToolName(item);
  return name
    ? projectAgentToolActivity({
        toolCallId: item.id,
        name,
        phase,
        // Native dynamic items retain requested args, not host-hook execution facts.
        args: item.type === "dynamicToolCall" ? undefined : itemToolArgs(item),
        meta,
        status:
          item.type === "collabAgentToolCall" && item.status === "interrupted"
            ? "failed"
            : unknownItemStatus(item)
              ? "unknown"
              : itemStatus(item),
        result: { details: itemToolResult(item) },
        ...(item.type === "collabAgentToolCall" && item.tool === "wait"
          ? { nativeOperation: "wait" }
          : {}),
      })
    : undefined;
}

export function isNativePostToolUseRelayItem(item: CodexThreadItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
      return true;
    default:
      return false;
  }
}

export function shouldSuppressChannelProgressForItem(item: CodexThreadItem): boolean {
  if (isProjectedNativeToolItem(item)) {
    return true;
  }
  // Dynamic OpenClaw tool requests are emitted at the item/tool/call request
  // boundary. Re-emitting item notifications can duplicate start/result progress.
  return item.type === "dynamicToolCall";
}

export function itemToolArgs(item: CodexThreadItem): Record<string, unknown> | undefined {
  if (item.type === "commandExecution") {
    return sanitizeCodexAgentEventRecord({
      command: item.command,
      ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
    });
  }
  if (item.type === "fileChange") {
    return sanitizeCodexAgentEventRecord({
      changes: itemFileChangesForTranscript(item),
    });
  }
  if (item.type === "webSearch") {
    return webSearchToolArgs(item);
  }
  if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") {
    return sanitizeCodexToolArguments(item.arguments);
  }
  return undefined;
}

export function isCommandBearingToolItem(
  item: CodexThreadItem,
  args: Record<string, unknown> | undefined,
): boolean {
  if (item.type === "commandExecution") {
    return true;
  }
  return typeof args?.command === "string" && args.command.trim().length > 0;
}

function webSearchToolArgs(item: CodexThreadItem): Record<string, unknown> {
  const args = projectCodexWebSearchItem(item);
  if (!args.query && !args.url && !args.pattern) {
    args.queryUnavailable = true;
  }
  return sanitizeCodexAgentEventRecord(args);
}

export function itemToolResult(item: CodexThreadItem): Record<string, unknown> | undefined {
  if (item.type === "commandExecution") {
    return sanitizeCodexAgentEventRecord({
      status: item.status,
      exitCode: item.exitCode,
      durationMs: item.durationMs,
    });
  }
  if (item.type === "fileChange") {
    return sanitizeCodexAgentEventRecord({
      status: item.status,
      changes: itemFileChanges(item),
    });
  }
  if (item.type === "mcpToolCall") {
    return sanitizeCodexAgentEventRecord({
      status: item.status,
      durationMs: item.durationMs,
      ...(item.error ? { error: item.error } : {}),
      ...(item.result ? { result: item.result } : {}),
    });
  }
  if (item.type === "webSearch") {
    return sanitizeCodexAgentEventRecord({
      status: itemStatus(item),
      ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
      ...webSearchToolArgs(item),
    });
  }
  return undefined;
}

type CodexFileChangeSummary = {
  path: string;
  kind: unknown;
};

type CodexTranscriptFileChange = CodexFileChangeSummary & {
  diff?: string;
  diffTruncated?: true;
  stat?: { added: number; removed: number };
};

function itemFileChangeRecords(item: CodexThreadItem): JsonObject[] {
  const changes = item.changes;
  return Array.isArray(changes) ? changes.filter(isJsonObject) : [];
}

function itemFileChanges(item: CodexThreadItem): CodexFileChangeSummary[] {
  return itemFileChangeRecords(item).flatMap((change) => {
    const path = normalizeOptionalString(change.path);
    if (!path || change.kind === undefined) {
      return [];
    }
    return [{ path, kind: change.kind }];
  });
}

function countFileContentLines(content: string): number {
  if (!content) {
    return 0;
  }
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length;
}

function fileChangeDiffStat(diff: string, kind: unknown): { added: number; removed: number } {
  const kindType =
    typeof kind === "string"
      ? kind
      : isJsonObject(kind)
        ? normalizeOptionalString(kind.type)
        : undefined;
  if (kindType === "add") {
    return { added: countFileContentLines(diff), removed: 0 };
  }
  if (kindType === "delete") {
    return { added: 0, removed: countFileContentLines(diff) };
  }
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function truncateFileChangeDiffAtLineBoundary(
  diff: string,
  maxChars: number,
): { diff?: string; diffTruncated?: true } {
  if (diff.length <= maxChars) {
    return { diff };
  }
  if (maxChars <= 0) {
    return { diffTruncated: true };
  }
  const boundary = diff.lastIndexOf("\n", maxChars - 1);
  return boundary >= 0
    ? { diff: diff.slice(0, boundary + 1), diffTruncated: true }
    : { diffTruncated: true };
}

function itemFileChangesForTranscript(item: CodexThreadItem): CodexTranscriptFileChange[] {
  let remainingDiffChars = 10_000;
  return itemFileChangeRecords(item).flatMap((change) => {
    const path = normalizeOptionalString(change.path);
    if (!path || change.kind === undefined) {
      return [];
    }
    const result: CodexTranscriptFileChange = { path, kind: change.kind };
    if (typeof change.diff !== "string") {
      return [result];
    }
    result.stat = fileChangeDiffStat(change.diff, change.kind);
    const bounded = truncateFileChangeDiffAtLineBoundary(change.diff, remainingDiffChars);
    if (bounded.diff !== undefined) {
      result.diff = bounded.diff;
      remainingDiffChars -= bounded.diff.length;
    }
    if (bounded.diffTruncated) {
      result.diffTruncated = true;
    }
    return [result];
  });
}

export function itemToolError(
  item: CodexThreadItem,
  status: ReturnType<typeof itemStatus>,
  outputTextByItem?: ReadonlyMap<string, string>,
): string | undefined {
  if (status === "blocked") {
    return "codex native tool blocked";
  }
  if (status !== "failed") {
    return undefined;
  }
  return itemOutputText(item, outputTextByItem) ?? "codex native tool failed";
}

export function itemMeta(
  item: CodexThreadItem,
  detailMode: ToolProgressDetailMode = "explain",
): string | undefined {
  if (item.type === "commandExecution" && typeof item.command === "string") {
    return inferToolMetaFromArgs(
      "exec",
      {
        command: item.command,
        cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      },
      { detailMode },
    );
  }
  if (item.type === "webSearch") {
    return inferToolMetaFromArgs("web_search", webSearchToolArgs(item), { detailMode });
  }
  const toolName = itemName(item);
  if ((item.type === "dynamicToolCall" || item.type === "mcpToolCall") && toolName) {
    return inferToolMetaFromArgs(toolName, item.arguments, { detailMode });
  }
  return undefined;
}

export function itemOutputText(
  item: CodexThreadItem,
  outputTextByItem?: ReadonlyMap<string, string>,
): string | undefined {
  const output = itemObservedOutputText(item, outputTextByItem)?.trim();
  return output ? truncateNativeToolTranscriptText(output, "Codex") : undefined;
}

function itemObservedOutputText(
  item: CodexThreadItem,
  outputTextByItem?: ReadonlyMap<string, string>,
): string | undefined {
  if (item.type === "commandExecution") {
    return item.aggregatedOutput ?? outputTextByItem?.get(item.id);
  }
  if (item.type === "dynamicToolCall") {
    return collectDynamicToolContentText(item.contentItems);
  }
  if (item.type === "mcpToolCall") {
    return item.error
      ? stringifyJsonValue(item.error)
      : item.result
        ? stringifyJsonValue(item.result)
        : undefined;
  }
  return undefined;
}

export function itemTranscriptResultText(
  item: CodexThreadItem,
  outputTextByItem?: ReadonlyMap<string, string>,
): string | undefined {
  const output = itemObservedOutputText(item, outputTextByItem);
  if (output !== undefined) {
    return output;
  }
  const result = itemToolResult(item);
  const resultText = result ? stringifyJsonValue(result) : undefined;
  return resultText ?? itemStatus(item);
}

function stringifyJsonValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}
