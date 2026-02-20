// SoundChain Forge — File tools: read, write, edit
// Mirrors Claude Code's Read, Write, Edit semantics.

import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
// Standalone type — no OpenClaw dependency needed at runtime
type AnyAgentTool = {
  name: string;
  label?: string;
  description?: string;
  parameters?: any;
  execute: (id: string, params: Record<string, unknown>) => Promise<any>;
};
import { PathGuard } from "./guards.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_READ_LINES = 2000;

function json<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// ─── forge_read ──────────────────────────────────────────────────────────

export function createReadTool(guard: PathGuard): AnyAgentTool {
  return {
    name: "forge_read",
    label: "Forge Read",
    description:
      "Read a file with line numbers (cat -n style). Returns up to 2000 lines. " +
      "Use offset and limit for large files.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Absolute path to the file to read" }),
      offset: Type.Optional(
        Type.Number({ description: "Line number to start from (1-based)", minimum: 1 }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Number of lines to read", minimum: 1, maximum: 5000 }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const filePath = typeof params.file_path === "string" ? params.file_path : "";
      const offset = typeof params.offset === "number" ? params.offset : 1;
      const limit =
        typeof params.limit === "number" ? Math.min(params.limit, 5000) : MAX_READ_LINES;

      const check = guard.validate(filePath);
      if (check.verdict !== "ALLOWED") {
        return json({ error: check.error });
      }

      try {
        const content = await readFile(check.resolved, "utf-8");
        const allLines = content.split("\n");
        const startIdx = offset - 1;
        const sliced = allLines.slice(startIdx, startIdx + limit);

        const numbered = sliced.map((line, i) => {
          const lineNum = String(startIdx + i + 1).padStart(6, " ");
          const truncated = line.length > 2000 ? line.slice(0, 2000) + "..." : line;
          return `${lineNum}\t${truncated}`;
        });

        return json({
          file: check.resolved,
          totalLines: allLines.length,
          showing: `${offset}-${offset + sliced.length - 1}`,
          content: numbered.join("\n"),
        });
      } catch (err: any) {
        return json({ error: `Read failed: ${err.message}` });
      }
    },
  } as AnyAgentTool;
}

// ─── forge_write ─────────────────────────────────────────────────────────

export function createWriteTool(guard: PathGuard): AnyAgentTool {
  return {
    name: "forge_write",
    label: "Forge Write",
    description:
      "Create or overwrite a file. Creates parent directories if needed. " +
      "Uses atomic write (temp file + rename) for safety. Max 10MB.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Absolute path to the file to write" }),
      content: Type.String({ description: "The content to write to the file" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const filePath = typeof params.file_path === "string" ? params.file_path : "";
      const content = typeof params.content === "string" ? params.content : "";

      const check = guard.validate(filePath);
      if (check.verdict !== "ALLOWED") {
        return json({ error: check.error });
      }

      if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE) {
        return json({ error: `Content exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` });
      }

      try {
        // Ensure parent directory exists
        await mkdir(dirname(check.resolved), { recursive: true });

        // Atomic write: write to temp, then rename
        const tmpPath = check.resolved + `.tmp.${randomBytes(4).toString("hex")}`;
        await writeFile(tmpPath, content, "utf-8");
        await rename(tmpPath, check.resolved);

        const lines = content.split("\n").length;
        const bytes = Buffer.byteLength(content, "utf-8");
        return json({
          written: check.resolved,
          lines,
          bytes,
          verdict: "WRITTEN",
        });
      } catch (err: any) {
        return json({ error: `Write failed: ${err.message}` });
      }
    },
  } as AnyAgentTool;
}

// ─── forge_edit ──────────────────────────────────────────────────────────

export function createEditTool(guard: PathGuard): AnyAgentTool {
  return {
    name: "forge_edit",
    label: "Forge Edit",
    description:
      "Edit a file by replacing an exact string match. " +
      "Fails if old_string is not found or not unique (unless replace_all is true). " +
      "old_string must be different from new_string.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Absolute path to the file to edit" }),
      old_string: Type.String({ description: "The exact text to find and replace" }),
      new_string: Type.String({ description: "The replacement text" }),
      replace_all: Type.Optional(
        Type.Boolean({ description: "Replace all occurrences (default false)" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const filePath = typeof params.file_path === "string" ? params.file_path : "";
      const oldStr = typeof params.old_string === "string" ? params.old_string : "";
      const newStr = typeof params.new_string === "string" ? params.new_string : "";
      const replaceAll = params.replace_all === true;

      const check = guard.validate(filePath);
      if (check.verdict !== "ALLOWED") {
        return json({ error: check.error });
      }

      if (!oldStr) {
        return json({ error: "old_string cannot be empty" });
      }

      if (oldStr === newStr) {
        return json({ error: "old_string and new_string are identical" });
      }

      try {
        const content = await readFile(check.resolved, "utf-8");

        // Count occurrences
        let count = 0;
        let idx = 0;
        while (true) {
          idx = content.indexOf(oldStr, idx);
          if (idx === -1) break;
          count++;
          idx += oldStr.length;
        }

        if (count === 0) {
          return json({ error: "old_string not found in file" });
        }

        if (count > 1 && !replaceAll) {
          return json({
            error: `old_string found ${count} times. Use replace_all: true to replace all, or provide more context to make it unique.`,
          });
        }

        let result: string;
        if (replaceAll) {
          result = content.split(oldStr).join(newStr);
        } else {
          const pos = content.indexOf(oldStr);
          result = content.slice(0, pos) + newStr + content.slice(pos + oldStr.length);
        }

        // Atomic write
        const tmpPath = check.resolved + `.tmp.${randomBytes(4).toString("hex")}`;
        await writeFile(tmpPath, result, "utf-8");
        await rename(tmpPath, check.resolved);

        return json({
          edited: check.resolved,
          replacements: replaceAll ? count : 1,
          verdict: "EDITED",
        });
      } catch (err: any) {
        return json({ error: `Edit failed: ${err.message}` });
      }
    },
  } as AnyAgentTool;
}
