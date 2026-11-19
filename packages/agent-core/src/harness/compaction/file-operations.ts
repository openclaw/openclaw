import type { ToolCall } from "@openclaw/llm-core";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../types.js";
import { createToolCallOccurrenceQueue } from "../session/tool-result-pairing.js";
import type { FileOperations } from "../types.js";
import { copyString } from "../utils/truncate.js";

function normalizeFileToolName(value: string): string {
  const name = value.toLowerCase();
  const separator = name.indexOf("__", name.startsWith("mcp__") ? 5 : 0);
  return separator < 0 ? name : name.slice(separator + 2);
}

function addFilePaths(target: Set<string>, value: unknown): void {
  for (const path of Array.isArray(value) ? value : []) {
    if (typeof path === "string") {
      target.add(copyString(path));
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

type FileOperationCallFact = { id: string; name: string; path?: string };
export type FileOperationMessageFact =
  | { role: "assistant"; calls: FileOperationCallFact[] }
  | {
      role: "toolResult";
      id: string;
      name: string;
      unchanged: boolean;
      written: Set<string>;
      edited: Set<string>;
    }
  | { role: "other" };

/** Row-local paths and outcome facts; arguments and result payloads never escape. */
export function collectFileOperationMessageFact(
  message: AgentMessage,
  identities?: WeakMap<ToolCall, FileOperationCallFact>,
): FileOperationMessageFact {
  if (message.role === "assistant") {
    const calls: FileOperationCallFact[] = [];
    for (const call of message.content) {
      if (call.type !== "toolCall") {
        continue;
      }
      let fact = identities?.get(call);
      if (!fact) {
        const args = asRecord(call.arguments);
        const path = [args?.path, args?.file_path, args?.filePath].find(
          (value): value is string => typeof value === "string",
        );
        fact = {
          id: copyString(call.id),
          name: copyString(normalizeFileToolName(call.name)),
          path: path === undefined ? undefined : copyString(path),
        };
        identities?.set(call, fact);
      }
      calls.push(fact);
    }
    return { role: "assistant", calls };
  }
  if (message.role !== "toolResult") {
    return { role: "other" };
  }
  const name = normalizeFileToolName(message.toolName);
  const written = new Set<string>();
  const edited = new Set<string>();
  if (name === "apply_patch") {
    for (const result of [message, ...(Array.isArray(message.content) ? message.content : [])]) {
      const summary = asRecord(asRecord(asRecord(result)?.details)?.summary);
      addFilePaths(written, summary?.added);
      addFilePaths(edited, summary?.modified);
    }
  }
  // Deleted paths no longer exist for a continuation to inspect, so omit them.
  return {
    role: "toolResult",
    id: copyString(message.toolCallId),
    name: copyString(name),
    unchanged: asRecord(message.details)?.changed === false,
    written,
    edited,
  };
}

/** Recompute outcomes over this exact selection, preserving repeated call occurrences. */
export function extractFileOpsFromFacts(
  messages: readonly FileOperationMessageFact[],
  fileOps: FileOperations,
): void {
  const calls = createToolCallOccurrenceQueue<FileOperationCallFact>();
  const unchanged = new Set<FileOperationCallFact>();
  for (const message of messages) {
    if (message.role === "assistant") {
      calls.clear();
      for (const call of message.calls) {
        calls.add(call.id, call);
      }
    } else if (message.role === "toolResult") {
      const occurrence = calls.claim(message.id);
      if (
        occurrence?.name === message.name &&
        (message.name === "edit" || message.name === "write") &&
        message.unchanged
      ) {
        unchanged.add(occurrence);
      }
    } else {
      calls.clear();
    }
  }
  for (const message of messages) {
    if (message.role === "toolResult") {
      for (const path of message.written) {
        fileOps.written.add(path);
      }
      for (const path of message.edited) {
        fileOps.edited.add(path);
      }
    } else if (message.role === "assistant") {
      for (const call of message.calls) {
        if (!call.path || unchanged.has(call)) {
          continue;
        }
        switch (call.name) {
          case "read":
            fileOps.read.add(call.path);
            break;
          case "write":
            fileOps.written.add(call.path);
            break;
          case "edit":
            fileOps.edited.add(call.path);
            break;
        }
      }
    }
  }
}

/** Array callers preserve object-alias outcomes while sharing the fact reducer. */
export function extractFileOpsFromMessages(
  messages: readonly AgentMessage[],
  fileOps: FileOperations,
): void {
  const identities = new WeakMap<ToolCall, FileOperationCallFact>();
  extractFileOpsFromFacts(
    messages.map((message) => collectFileOperationMessageFact(message, identities)),
    fileOps,
  );
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
