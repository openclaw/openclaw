import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../types.js";
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

type FileCall = { id: string; name: string; path?: string; unchanged?: boolean };
export type FileOperationMessage =
  | { role: "assistant"; calls: FileCall[] }
  | {
      role: "toolResult";
      id: string;
      name: string;
      unchanged: boolean;
      added: string[];
      modified: string[];
    }
  | { role: Exclude<AgentMessage["role"], "assistant" | "toolResult"> };

/** Record only the paths and occurrence outcomes needed after the raw row is released. */
export function prepareFileOperationMessage(message: AgentMessage): FileOperationMessage {
  if (message.role === "assistant") {
    return {
      role: message.role,
      calls: message.content.flatMap((call) => {
        if (call.type !== "toolCall") {
          return [];
        }
        const args = asRecord(call.arguments);
        return [
          {
            id: call.id,
            name: normalizeFileToolName(call.name),
            path: [args?.path, args?.file_path, args?.filePath].find(
              (value): value is string => typeof value === "string",
            ),
          },
        ];
      }),
    };
  }
  if (message.role !== "toolResult") {
    return { role: message.role };
  }
  const name = normalizeFileToolName(message.toolName);
  const added = new Set<string>();
  const modified = new Set<string>();
  if (name === "apply_patch") {
    for (const result of [message, ...(Array.isArray(message.content) ? message.content : [])]) {
      const summary = asRecord(asRecord(asRecord(result)?.details)?.summary);
      addFilePaths(added, summary?.added);
      addFilePaths(modified, summary?.modified);
    }
  }
  return {
    role: message.role,
    id: message.toolCallId,
    name,
    unchanged: asRecord(message.details)?.changed === false,
    added: [...added],
    modified: [...modified],
  };
}

/** Consume payload-free facts with the same conservative metadata rules as array callers. */
export function extractFileOpsFromFacts(
  messages: Iterable<FileOperationMessage>,
  fileOps: FileOperations,
): void {
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.calls) {
        if (!call.path) {
          continue;
        }
        if (call.name === "read") {
          fileOps.read.add(call.path);
        } else if (call.name === "write") {
          fileOps.written.add(call.path);
        } else if (call.name === "edit") {
          fileOps.edited.add(call.path);
        }
      }
    } else if (message.role === "toolResult") {
      addFilePaths(fileOps.written, message.added);
      addFilePaths(fileOps.edited, message.modified);
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

/** Legacy single-message API uses the same fact owner as source compaction. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  extractFileOpsFromFacts([prepareFileOperationMessage(message)], fileOps);
}
