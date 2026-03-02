/**
 * Files Extension
 *
 * /files command lists all files the model has read/written/edited in the active session branch,
 * coalesced by path and sorted newest first. Selecting a file opens it in VS Code.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { showPagedSelectList } from "./ui/paged-select";

interface FileEntry {
  path: string;
  operations: Set<"read" | "write" | "edit">;
  lastTimestamp: number;
}

type FileToolName = "read" | "write" | "edit";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("files", {
    description: "Show files read/written/edited in this session",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("No UI available", "error");
        return;
      }

      // Get the current branch (path from leaf to root)
      const branch = ctx.sessionManager.getBranch();

      // First pass: collect tool calls (id -> {path, name}) from assistant messages
      const toolCalls = new Map<string, { path: string; name: FileToolName; timestamp: number }>();

      for (const entry of branch) {
        if (entry.type !== "message") {
          continue;
        }
        const msg = entry.message;

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "toolCall") {
              const name = block.name;
              if (name === "read" || name === "write" || name === "edit") {
                const path = block.arguments?.path;
                if (path && typeof path === "string") {
                  toolCalls.set(block.id, { path, name, timestamp: msg.timestamp });
                }
              }
            }
          }
        }
      }

      // Second pass: match tool results to get the actual execution timestamp
      const fileMap = new Map<string, FileEntry>();

      for (const entry of branch) {
        if (entry.type !== "message") {
          continue;
        }
        const msg = entry.message;

        if (msg.role === "toolResult") {
          const toolCall = toolCalls.get(msg.toolCallId);
          if (!toolCall) {
            continue;
          }

          const { path, name } = toolCall;
          const timestamp = msg.timestamp;

          const existing = fileMap.get(path);
          if (existing) {
            existing.operations.add(name);
            if (timestamp > existing.lastTimestamp) {
              existing.lastTimestamp = timestamp;
            }
          } else {
            fileMap.set(path, {
              path,
              operations: new Set([name]),
              lastTimestamp: timestamp,
            });
          }
        }
      }

      if (fileMap.size === 0) {
        ctx.ui.notify("No files read/written/edited in this session", "info");
        return;
      }

      // Sort by most recent first
      const files = Array.from(fileMap.values()).toSorted(
        (a, b) => b.lastTimestamp - a.lastTimestamp,
      );

      const openSelected = async (file: FileEntry): Promise<void> => {
        try {
          await pi.exec("code", ["-g", file.path], { cwd: ctx.cwd });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to open ${file.path}: ${message}`, "error");
        }
      };

      const items = files.map((file) => {
        const ops: string[] = [];
        if (file.operations.has("read")) {
          ops.push("R");
        }
        if (file.operations.has("write")) {
          ops.push("W");
        }
        if (file.operations.has("edit")) {
          ops.push("E");
        }
        return {
          value: file,
          label: `${ops.join("")} ${file.path}`,
        };
      });
      await showPagedSelectList({
        ctx,
        title: " Select file to open",
        items,
        onSelect: (item) => {
          void openSelected(item.value as FileEntry);
        },
      });
    },
  });
}
