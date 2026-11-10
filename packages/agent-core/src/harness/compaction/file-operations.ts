import type { ToolCall } from "@openclaw/llm-core";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../types.js";
import { createToolCallOccurrenceQueue } from "../session/tool-result-pairing.js";
import type { FileOperations } from "../types.js";

function normalizeFileToolName(value: string): string {
  const name = value.toLowerCase();
  const separator = name.indexOf("__", name.startsWith("mcp__") ? 5 : 0);
  return separator < 0 ? name : name.slice(separator + 2);
}

function addFilePaths(target: Set<string>, value: unknown): void {
  for (const path of Array.isArray(value) ? value : []) {
    if (typeof path === "string") {
      target.add(path);
    }
  }
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** Restore file metadata recorded by an earlier compaction or branch summary. */
export function mergeSummaryFileOperations(
  fileOps: FileOperations,
  details: { readFiles: string[]; modifiedFiles: string[] },
): void {
  addFilePaths(fileOps.read, details.readFiles);
  addFilePaths(fileOps.edited, details.modifiedFiles);
}

/** Pair outcomes within each tool turn before collecting conservative file metadata. */
export function extractFileOpsFromMessages(
  messages: readonly AgentMessage[],
  fileOps: FileOperations,
): void {
  const calls = createToolCallOccurrenceQueue<{ call: ToolCall; name: string }>();
  const unchanged = new Set<ToolCall>();
  for (const message of messages) {
    if (message.role === "assistant") {
      calls.clear();
      for (const call of message.content) {
        if (call.type === "toolCall") {
          calls.add(call.id, { call, name: normalizeFileToolName(call.name) });
        }
      }
    } else if (message.role === "toolResult") {
      const occurrence = calls.claim(message.toolCallId);
      const name = normalizeFileToolName(message.toolName);
      if (
        occurrence?.name === name &&
        (name === "edit" || name === "write") &&
        asRecord(message.details)?.changed === false
      ) {
        unchanged.add(occurrence.call);
      }
    } else {
      calls.clear();
    }
  }
  for (const message of messages) {
    extractFileOpsFromMessage(message, fileOps, unchanged);
  }
}

function extractFileOpsFromMessage(
  message: AgentMessage,
  fileOps: FileOperations,
  unchanged: ReadonlySet<ToolCall>,
): void {
  if (message.role === "toolResult") {
    if (normalizeFileToolName(message.toolName) !== "apply_patch") {
      return;
    }
    for (const result of [message, ...(Array.isArray(message.content) ? message.content : [])]) {
      const details = asRecord(asRecord(result)?.details);
      const summary = asRecord(details?.summary);
      addFilePaths(fileOps.written, summary?.added);
      addFilePaths(fileOps.edited, summary?.modified);
    }
    // Deleted paths no longer exist for a continuation to inspect, so omit them.
    return;
  }

  if (message.role !== "assistant") {
    return;
  }
  for (const toolCall of message.content) {
    if (toolCall.type !== "toolCall" || unchanged.has(toolCall)) {
      continue;
    }
    const args = asRecord(toolCall.arguments);
    const path = [args?.path, args?.file_path, args?.filePath].find(
      (value): value is string => typeof value === "string",
    );
    if (!path) {
      continue;
    }
    switch (normalizeFileToolName(toolCall.name)) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}

/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles: readOnly, modifiedFiles };
}

// File lists ratchet across compactions (prior summary entries merge into the
// next accumulation), so an unbounded join grows without limit in long
// sessions. Hard caps keep the model-visible section bounded per the
// context-budget invariant; overflow collapses to a "...and N more" line.
const MAX_FILE_OPS_LIST_CHARS = 900;

function formatBoundedFileList(tag: string, files: string[], maxChars: number): string {
  if (files.length === 0 || maxChars <= 0) {
    return "";
  }
  const openTag = `<${tag}>\n`;
  const closeTag = `\n</${tag}>`;
  const lines: string[] = [];
  let usedChars = openTag.length + closeTag.length;

  for (let i = 0; i < files.length; i++) {
    const line = `${files[i]}\n`;
    const remaining = files.length - i - 1;
    const overflowLine = remaining > 0 ? `...and ${remaining} more\n` : "";
    const projected = usedChars + line.length + overflowLine.length;
    if (projected > maxChars) {
      const overflow = `...and ${files.length - i} more\n`;
      if (usedChars + overflow.length <= maxChars) {
        lines.push(overflow);
      }
      break;
    }
    lines.push(line);
    usedChars += line.length;
  }

  return lines.length > 0 ? `${openTag}${lines.join("").trimEnd()}${closeTag}` : "";
}

/** Format file lists as bounded summary metadata tags. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections = [
    formatBoundedFileList("read-files", readFiles, MAX_FILE_OPS_LIST_CHARS),
    formatBoundedFileList("modified-files", modifiedFiles, MAX_FILE_OPS_LIST_CHARS),
  ].filter(Boolean);
  // Both 900-character lists and their separators fit the 2,000-character section cap.
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}
