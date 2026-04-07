import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { resolvePathFromInput } from "./path-policy.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const listSchema = Type.Object({
  path: Type.String({
    description: "Relative or absolute path to the directory to list.",
  }),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ListEntry = {
  name: string;
  type: "file" | "directory";
  /** Byte size (files only). */
  size: number | null;
  /** ISO-8601 last-modified timestamp. */
  mtime: string;
};

export type ListToolDetails = {
  path: string;
  entries: ListEntry[];
  count: number;
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling on entries returned to keep token usage bounded. */
const MAX_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a `list` tool scoped to a workspace root directory.
 *
 * The tool enumerates files and directories within the workspace using the
 * same boundary-enforcement approach as the `read` and `write` tools:
 * the resolved target path must stay inside `cwd` after symlink resolution.
 */
export function createListTool(
  options: { cwd?: string; workspaceOnly?: boolean } = {},
): AgentTool<typeof listSchema, ListToolDetails> {
  const cwd = options.cwd ?? process.cwd();
  const workspaceOnly = options.workspaceOnly !== false;

  return {
    name: "list",
    label: "list",
    description:
      "List files and directories at the given path. Returns name, type, size (bytes, files only), and last-modified time for each entry.",
    parameters: listSchema,
    execute: async (_toolCallId, args) => {
      const params = args as { path?: string };
      const rawPath = typeof params.path === "string" ? params.path.trim() : "";
      if (!rawPath) {
        throw new Error("Provide a directory path.");
      }

      // Resolve the requested path relative to the workspace root.
      const resolved = resolvePathFromInput(rawPath, cwd);
      const absolute = path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved);

      // Workspace boundary check: the resolved real path must be inside cwd.
      if (workspaceOnly) {
        const real = await fs.realpath(absolute).catch(() => absolute);
        const root = await fs.realpath(cwd).catch(() => cwd);
        const relative = path.relative(root, real);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error(`Path is outside the workspace root.`);
        }
      }

      // Verify the target is actually a directory.
      const stat = await fs.stat(absolute).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          throw new Error(`Directory not found: ${rawPath}`);
        }
        throw err;
      });
      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${rawPath}`);
      }

      // Read the directory entries with their types.
      const dirents = await fs.readdir(absolute, { withFileTypes: true });

      const entries: ListEntry[] = [];
      let truncated = false;

      for (const dirent of dirents) {
        if (entries.length >= MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const entryPath = path.join(absolute, dirent.name);
        const isDir = dirent.isDirectory();
        let size: number | null = null;
        let mtime = "";

        try {
          const entryStat = await fs.stat(entryPath);
          size = isDir ? null : entryStat.size;
          mtime = entryStat.mtime.toISOString();
        } catch {
          // If we can't stat an individual entry (broken symlink, etc.),
          // include it with null metadata rather than failing the whole listing.
          mtime = "";
        }

        entries.push({
          name: dirent.name,
          type: isDir ? "directory" : "file",
          size,
          mtime,
        });
      }

      // Sort: directories first, then alphabetically within each group.
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      // Format human-readable output.
      const lines = entries.map((e) => {
        const suffix = e.type === "directory" ? "/" : "";
        const sizeStr = e.size != null ? ` (${formatBytes(e.size)})` : "";
        return `${e.name}${suffix}${sizeStr}`;
      });

      const header = `Directory: ${rawPath}  (${entries.length} entries${truncated ? ", truncated" : ""})`;
      const text = [header, ...lines].join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          path: rawPath,
          entries,
          count: entries.length,
          truncated,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}
