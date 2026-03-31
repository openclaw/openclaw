import * as fs from "node:fs";
import * as path from "node:path";
import type { ProgressEntry, SessionContentBlock, SessionEntry } from "./types.js";

/**
 * Find the most recently modified Claude Code JSONL session file.
 *
 * Claude Code stores sessions under `~/.claude/projects/<hash>/<uuid>.jsonl`.
 * When `runAsUser` is set, the home directory is `/home/<user>`.
 */
export function findLatestSession(homeDir: string): string | null {
  const projectsDir = path.join(homeDir, ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return null;

  let latest: string | null = null;
  let latestMtime = 0;

  for (const projectEntry of readdirSafe(projectsDir)) {
    const projectPath = path.join(projectsDir, projectEntry);
    if (!statIsDir(projectPath)) continue;

    for (const file of readdirSafe(projectPath)) {
      if (!/^[0-9a-f]+\.jsonl$/i.test(file)) continue;
      const fullPath = path.join(projectPath, file);
      const mtime = mtimeSafe(fullPath);
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = fullPath;
      }
    }
  }
  return latest;
}

/**
 * Parse new JSONL entries starting from `byteOffset`.
 * Returns parsed entries and the new byte offset.
 */
export function parseNewEntries(
  filepath: string,
  byteOffset: number,
): { entries: ProgressEntry[]; newOffset: number } {
  const result: ProgressEntry[] = [];
  let size: number;
  try {
    size = fs.statSync(filepath).size;
  } catch {
    return { entries: result, newOffset: byteOffset };
  }
  if (size <= byteOffset) {
    return { entries: result, newOffset: byteOffset };
  }

  const fd = fs.openSync(filepath, "r");
  try {
    const buf = Buffer.alloc(size - byteOffset);
    fs.readSync(fd, buf, 0, buf.length, byteOffset);
    const text = buf.toString("utf-8");

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: SessionEntry;
      try {
        obj = JSON.parse(trimmed) as SessionEntry;
      } catch {
        continue;
      }
      if (obj.type !== "assistant") continue;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content as SessionContentBlock[]) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && "text" in block) {
          const t = (block.text as string).trim();
          if (t) result.push({ kind: "text", content: t.slice(0, 200) });
        } else if (block.type === "tool_use" && "name" in block) {
          const entry = formatToolEntry(block as { name: string; input: Record<string, unknown> });
          if (entry) result.push(entry);
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return { entries: result, newOffset: size };
}

/**
 * Extract the final assistant text from the last run in a session file.
 * Uses `last-prompt` markers to find the boundary of the current run,
 * and skips content after context compaction events.
 */
export function extractFinalResult(filepath: string): string {
  if (!fs.existsSync(filepath)) return "";

  const raw = fs.readFileSync(filepath, "utf-8");
  const entries: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as SessionEntry);
    } catch {
      /* skip malformed lines */
    }
  }

  // Find the last `last-prompt` boundary
  let promptIdx = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "last-prompt") {
      promptIdx = i;
      break;
    }
  }

  const texts: string[] = [];
  let skipAfterCompaction = false;

  for (let i = promptIdx; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type === "user") {
      // A user message with very long content indicates a compaction event
      const content = entry.message?.content;
      if (Array.isArray(content) && content.length >= 50) {
        skipAfterCompaction = true;
      }
    } else if (entry.type === "assistant" && !skipAfterCompaction) {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as SessionContentBlock[]) {
        if (block && typeof block === "object" && block.type === "text" && "text" in block) {
          const t = (block.text as string).trim();
          if (t) texts.push(t);
        }
      }
    }
  }

  return texts.join("\n\n");
}

function formatToolEntry(block: {
  name: string;
  input: Record<string, unknown>;
}): ProgressEntry | null {
  const name = block.name;
  const input = block.input ?? {};
  switch (name) {
    case "Write":
      return {
        kind: "tool",
        content: `Write: ${basename(input.file_path as string)}`,
      };
    case "Edit":
      return {
        kind: "tool",
        content: `Edit: ${basename(input.file_path as string)}`,
      };
    case "Bash":
      return {
        kind: "tool",
        content: `Exec: ${((input.command as string) ?? "").slice(0, 80)}`,
      };
    case "Agent":
      return {
        kind: "tool",
        content: `Subagent: ${(input.description as string) ?? ""}`,
      };
    default:
      // Skip Read/Glob/Grep to reduce noise
      return null;
  }
}

function basename(p: unknown): string {
  if (typeof p !== "string") return "?";
  return path.basename(p);
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function statIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function mtimeSafe(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
