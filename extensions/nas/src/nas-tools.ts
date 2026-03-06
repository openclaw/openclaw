import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "../../../src/plugins/types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_ROOT = "/mnt/nas";
const DEFAULT_MAX_READ_BYTES = 200_000;
const DEFAULT_MAX_LIST_ENTRIES = 200;
const DEFAULT_MAX_SEARCH_RESULTS = 50;

type NasPluginConfig = {
  root?: string;
  maxReadBytes?: number;
  maxListEntries?: number;
  maxSearchResults?: number;
};

function stringEnum<T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    description,
  });
}

function getConfig(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as NasPluginConfig;
  return {
    root: (pluginConfig.root?.trim() || process.env.OPENCLAW_NAS_ROOT || DEFAULT_ROOT).trim(),
    maxReadBytes:
      typeof pluginConfig.maxReadBytes === "number" && pluginConfig.maxReadBytes > 1_024
        ? Math.trunc(pluginConfig.maxReadBytes)
        : DEFAULT_MAX_READ_BYTES,
    maxListEntries:
      typeof pluginConfig.maxListEntries === "number" && pluginConfig.maxListEntries > 0
        ? Math.trunc(pluginConfig.maxListEntries)
        : DEFAULT_MAX_LIST_ENTRIES,
    maxSearchResults:
      typeof pluginConfig.maxSearchResults === "number" && pluginConfig.maxSearchResults > 0
        ? Math.trunc(pluginConfig.maxSearchResults)
        : DEFAULT_MAX_SEARCH_RESULTS,
  };
}

function normalizeRelPath(rawPath: unknown): string {
  if (typeof rawPath !== "string") {
    return ".";
  }
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "/") {
    return ".";
  }
  if (trimmed === DEFAULT_ROOT) {
    return ".";
  }
  if (trimmed.startsWith(DEFAULT_ROOT + "/")) {
    return trimmed.slice(DEFAULT_ROOT.length + 1);
  }
  return trimmed.replace(/^\/+/, "");
}

function looksLikeFilenameQuery(rawQuery: string): boolean {
  const q = rawQuery.trim();
  if (!q) {
    return false;
  }
  return /[\\/]/.test(q) || /\.[A-Za-z0-9]{2,8}$/.test(q) || /[_-]/.test(q);
}

function resolveInsideRoot(root: string, relPath: string): string {
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, relPath);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error(`path escapes NAS root: ${relPath}`);
  }
  return abs;
}

function toRelPath(root: string, absPath: string): string {
  const rel = path.relative(path.resolve(root), absPath);
  return rel || ".";
}

async function assertExists(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(`path not found: ${targetPath}`);
  }
}

async function listDirectory(params: {
  root: string;
  relPath: string;
  limit: number;
}): Promise<{
  root: string;
  path: string;
  total: number;
  shown: number;
  entries: Array<{ name: string; path: string; type: "file" | "dir" | "other" }>;
}> {
  const absPath = resolveInsideRoot(params.root, params.relPath);
  await assertExists(absPath);
  const dirents = await fs.readdir(absPath, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  const sliced = dirents.slice(0, params.limit);
  return {
    root: path.resolve(params.root),
    path: toRelPath(params.root, absPath),
    total: dirents.length,
    shown: sliced.length,
    entries: sliced.map((d) => ({
      name: d.name,
      path: toRelPath(params.root, path.join(absPath, d.name)),
      type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
    })),
  };
}

async function runSearch(params: {
  root: string;
  relPath: string;
  query: string;
  maxResults: number;
}): Promise<{
  root: string;
  path: string;
  query: string;
  count: number;
  truncated: boolean;
  matches: Array<{ file: string; line: number; text: string }>;
}> {
  const absPath = resolveInsideRoot(params.root, params.relPath);
  await assertExists(absPath);
  const max = Math.max(1, Math.min(500, params.maxResults));

  const args = [
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--hidden",
    "--max-count",
    String(max),
    params.query,
    absPath,
  ];

  let stdout = "";
  try {
    const res = await execFileAsync("rg", args, { maxBuffer: 5 * 1024 * 1024 });
    stdout = res.stdout ?? "";
  } catch (error) {
    const err = error as { stdout?: string; code?: number | string };
    if (err.code === 1) {
      stdout = err.stdout ?? "";
    } else {
      throw new Error("ripgrep (rg) is required for nas_search");
    }
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const matches = lines.slice(0, max).map((line) => {
    const first = line.indexOf(":");
    const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
    if (first < 0 || second < 0) {
      return { file: line, line: 0, text: "" };
    }
    const absFile = line.slice(0, first);
    const lineNum = Number.parseInt(line.slice(first + 1, second), 10);
    const text = line.slice(second + 1);
    return {
      file: toRelPath(params.root, absFile),
      line: Number.isFinite(lineNum) ? lineNum : 0,
      text,
    };
  });

  return {
    root: path.resolve(params.root),
    path: toRelPath(params.root, absPath),
    query: params.query,
    count: matches.length,
    truncated: lines.length > max,
    matches,
  };
}

async function runFilenameSearch(params: {
  root: string;
  relPath: string;
  query: string;
  maxResults: number;
}): Promise<{
  root: string;
  path: string;
  query: string;
  count: number;
  truncated: boolean;
  matches: Array<{ file: string }>;
}> {
  const absPath = resolveInsideRoot(params.root, params.relPath);
  await assertExists(absPath);
  const max = Math.max(1, Math.min(500, params.maxResults));
  const needle = params.query.trim().toLocaleLowerCase();
  if (!needle) {
    return {
      root: path.resolve(params.root),
      path: toRelPath(params.root, absPath),
      query: params.query,
      count: 0,
      truncated: false,
      matches: [],
    };
  }

  let stdout = "";
  try {
    const res = await execFileAsync("rg", ["--files", "--hidden", absPath], {
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = res.stdout ?? "";
  } catch (error) {
    const err = error as { stdout?: string; code?: number | string };
    if (err.code === 1) {
      stdout = err.stdout ?? "";
    } else {
      throw new Error("ripgrep (rg) is required for nas_search");
    }
  }

  const files = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((absFile) => {
      const relFile = toRelPath(params.root, absFile);
      const baseName = path.basename(relFile);
      return (
        relFile.toLocaleLowerCase().includes(needle) || baseName.toLocaleLowerCase().includes(needle)
      );
    });

  return {
    root: path.resolve(params.root),
    path: toRelPath(params.root, absPath),
    query: params.query,
    count: Math.min(files.length, max),
    truncated: files.length > max,
    matches: files.slice(0, max).map((absFile) => ({
      file: toRelPath(params.root, absFile),
    })),
  };
}

async function readFileWithinRoot(params: {
  root: string;
  relPath: string;
  maxReadBytes: number;
}): Promise<{
  root: string;
  path: string;
  bytes: number;
  truncated: boolean;
  content: string;
}> {
  const absPath = resolveInsideRoot(params.root, params.relPath);
  await assertExists(absPath);
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    throw new Error("nas_read target must be a file");
  }

  const maxBytes = Math.max(1_024, Math.min(2_000_000, params.maxReadBytes));
  const full = await fs.readFile(absPath, "utf8");
  const truncated = Buffer.byteLength(full, "utf8") > maxBytes;
  const content = truncated ? full.slice(0, maxBytes) : full;

  return {
    root: path.resolve(params.root),
    path: toRelPath(params.root, absPath),
    bytes: Buffer.byteLength(content, "utf8"),
    truncated,
    content,
  };
}

async function summarizeFile(params: {
  root: string;
  relPath: string;
  maxReadBytes: number;
}): Promise<{
  root: string;
  path: string;
  lines: number;
  bytes: number;
  summary: string;
  previewHead: string[];
  previewTail: string[];
}> {
  const readRes = await readFileWithinRoot(params);
  const lines = readRes.content.split(/\r?\n/);
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
  const head = nonEmpty.slice(0, 8);
  const tail = nonEmpty.slice(-8);

  const summaryParts: string[] = [];
  summaryParts.push(`Total lines: ${lines.length}`);
  summaryParts.push(`Read bytes: ${readRes.bytes}${readRes.truncated ? " (truncated)" : ""}`);
  if (head.length > 0) {
    summaryParts.push(`Starts with: ${head.slice(0, 2).join(" / ")}`);
  }
  if (tail.length > 0) {
    summaryParts.push(`Ends with: ${tail.slice(-2).join(" / ")}`);
  }

  return {
    root: readRes.root,
    path: readRes.path,
    lines: lines.length,
    bytes: readRes.bytes,
    summary: summaryParts.join(". "),
    previewHead: head,
    previewTail: tail,
  };
}

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

export function createNasTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const listParams = Type.Object(
    {
      path: Type.Optional(Type.String({ description: "Directory path under NAS root." })),
      limit: Type.Optional(
        Type.Number({
          description: "Max entries to return.",
          minimum: 1,
          maximum: 1000,
        }),
      ),
    },
    { additionalProperties: false },
  );

  const searchMode = ["content", "filename"] as const;
  const searchParams = Type.Object(
    {
      query: Type.String({ description: "Search text." }),
      path: Type.Optional(Type.String({ description: "Search base path under NAS root." })),
      maxResults: Type.Optional(
        Type.Number({ description: "Max matches.", minimum: 1, maximum: 500 }),
      ),
      mode: Type.Optional(
        stringEnum(searchMode, "Search mode (content uses ripgrep output text lines)."),
      ),
    },
    { additionalProperties: false },
  );

  const readParams = Type.Object(
    {
      file: Type.String({ description: "File path under NAS root." }),
      maxBytes: Type.Optional(
        Type.Number({ description: "Max bytes to read.", minimum: 1024, maximum: 2000000 }),
      ),
    },
    { additionalProperties: false },
  );

  const summaryParams = Type.Object(
    {
      file: Type.String({ description: "File path under NAS root." }),
      maxBytes: Type.Optional(
        Type.Number({ description: "Max bytes to read.", minimum: 1024, maximum: 2000000 }),
      ),
    },
    { additionalProperties: false },
  );

  return [
    {
      name: "nas_list",
      label: "NAS List",
      description: "List files/directories from NAS mount (default /mnt/nas).",
      parameters: listParams,
      execute: async (_id, rawParams) => {
        const cfg = getConfig(api);
        const params = rawParams as { path?: unknown; limit?: unknown };
        const relPath = normalizeRelPath(params.path);
        const requestedLimit =
          typeof params.limit === "number" && Number.isFinite(params.limit)
            ? Math.trunc(params.limit)
            : cfg.maxListEntries;
        const limit = Math.max(1, Math.min(1000, requestedLimit));
        const result = await listDirectory({
          root: cfg.root,
          relPath,
          limit,
        });
        return jsonResult(result);
      },
    },
    {
      name: "nas_search",
      label: "NAS Search",
      description: "Search text within NAS files using ripgrep under NAS root.",
      parameters: searchParams,
      execute: async (_id, rawParams) => {
        const cfg = getConfig(api);
        const params = rawParams as {
          query?: unknown;
          path?: unknown;
          maxResults?: unknown;
          mode?: unknown;
        };
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (!query) {
          throw new Error("query required");
        }
        const relPath = normalizeRelPath(params.path);
        const requestedMax =
          typeof params.maxResults === "number" && Number.isFinite(params.maxResults)
            ? Math.trunc(params.maxResults)
            : cfg.maxSearchResults;
        const maxResults = Math.max(1, Math.min(500, requestedMax));

        if (params.mode === "filename" || (params.mode == null && looksLikeFilenameQuery(query))) {
          const listing = await runFilenameSearch({
            root: cfg.root,
            relPath,
            query,
            maxResults,
          });
          return jsonResult(listing);
        }

        const result = await runSearch({
          root: cfg.root,
          relPath,
          query,
          maxResults,
        });
        return jsonResult(result);
      },
    },
    {
      name: "nas_read",
      label: "NAS Read",
      description: "Read a text file from NAS root.",
      parameters: readParams,
      execute: async (_id, rawParams) => {
        const cfg = getConfig(api);
        const params = rawParams as { file?: unknown; maxBytes?: unknown };
        const file = typeof params.file === "string" ? params.file.trim() : "";
        if (!file) {
          throw new Error("file required");
        }
        const maxBytes =
          typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes)
            ? Math.trunc(params.maxBytes)
            : cfg.maxReadBytes;
        const result = await readFileWithinRoot({
          root: cfg.root,
          relPath: normalizeRelPath(file),
          maxReadBytes: maxBytes,
        });
        return jsonResult(result);
      },
    },
    {
      name: "nas_summary",
      label: "NAS Summary",
      description: "Build a quick structural summary for a text file in NAS root.",
      parameters: summaryParams,
      execute: async (_id, rawParams) => {
        const cfg = getConfig(api);
        const params = rawParams as { file?: unknown; maxBytes?: unknown };
        const file = typeof params.file === "string" ? params.file.trim() : "";
        if (!file) {
          throw new Error("file required");
        }
        const maxBytes =
          typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes)
            ? Math.trunc(params.maxBytes)
            : cfg.maxReadBytes;
        const result = await summarizeFile({
          root: cfg.root,
          relPath: normalizeRelPath(file),
          maxReadBytes: maxBytes,
        });
        return jsonResult(result);
      },
    },
  ];
}
