import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

/**
 * Default directories where file writes are allowed.
 * macOS `os.tmpdir()` returns `/var/folders/.../`, not `/tmp/`.
 * `/tmp` is a symlink to `/private/tmp` on macOS — allow both.
 */
const DEFAULT_ALLOWED_DIRS = [
  os.tmpdir(),
  "/tmp",
  "/private/tmp",
  path.join(os.homedir(), ".cache"),
];

type PluginCfg = {
  allowedDirs?: string[];
};

function isPathAllowed(filePath: string, allowedDirs: string[]): boolean {
  const resolved = path.resolve(filePath);
  return allowedDirs.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}

export function createFileWriterTool(api: OpenClawPluginApi) {
  const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;
  const allowedDirs = [
    ...DEFAULT_ALLOWED_DIRS,
    ...(pluginCfg.allowedDirs ?? []).map((d) => path.resolve(d)),
  ];

  api.logger.info(`file-writer: allowed dirs: ${allowedDirs.join(", ")}`);

  return {
    name: "write_file",
    label: "Write File",
    description:
      "Write text content to a temporary file. Use this when you need to pass long text " +
      "to a command-line tool via exec (e.g. pass a memo body with --file /tmp/memo.txt). " +
      "The content is written as-is with no shell escaping issues. " +
      "Allowed paths: /tmp/*, ~/.cache/*, and any directories configured in allowedDirs.",
    parameters: Type.Object({
      file_path: Type.String({
        description:
          "Absolute path to write to. Must be under /tmp/ or ~/.cache/. Example: /tmp/memo-content.txt",
      }),
      content: Type.String({
        description: "The text content to write to the file.",
      }),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const filePath = params.file_path;
      const content = params.content;

      if (typeof filePath !== "string" || !filePath) {
        return { content: [{ type: "text", text: "Error: file_path is required" }] };
      }

      if (typeof content !== "string") {
        return { content: [{ type: "text", text: "Error: content is required" }] };
      }

      // Expand ~ to home directory
      const expandedPath = filePath.startsWith("~/")
        ? path.join(os.homedir(), filePath.slice(2))
        : filePath;
      const resolvedPath = path.resolve(expandedPath);

      if (!isPathAllowed(resolvedPath, allowedDirs)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Path not allowed. Must be under one of: ${allowedDirs.join(", ")}. Got: ${resolvedPath}`,
            },
          ],
        };
      }

      try {
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(resolvedPath, content, "utf-8");
        const stats = fs.statSync(resolvedPath);

        return {
          content: [{ type: "text", text: `Written ${stats.size} bytes to ${resolvedPath}` }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}
