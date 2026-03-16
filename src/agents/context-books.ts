import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { openBoundaryFile } from "../infra/boundary-file-read.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import type { BootstrapContextMode, BootstrapContextRunKind } from "./bootstrap-files.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

export const CONTEXT_BOOKS_DIRNAME = "context-books";

const CONTEXT_BOOK_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const CONTEXT_BOOK_MAX_FILE_BYTES = 512 * 1024;
const SUPPORTED_BOOTSTRAP_POSITIONS = new Set(["before_context", "after_context"]);

type RawContextBookDocument =
  | {
      entries?: unknown;
    }
  | unknown[];

type NormalizedContextBookEntry = {
  syntheticName: string;
  syntheticPath: string;
  content: string;
  order: number;
  sourcePath: string;
  sourceIndex: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseOrder(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
}

function normalizeEntryName(rawName: unknown, sourcePath: string, index: number): string {
  const trimmed = typeof rawName === "string" ? rawName.trim() : "";
  if (trimmed) {
    return trimmed;
  }
  return `${path.basename(sourcePath)}#${index + 1}`;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "entry";
}

function parseContextBookDocument(raw: string, sourcePath: string): RawContextBookDocument | null {
  const extension = path.extname(sourcePath).toLowerCase();
  try {
    const parsed =
      extension === ".json"
        ? (JSON.parse(raw) as unknown)
        : (YAML.parse(raw, { schema: "core" }) as unknown);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (isRecord(parsed)) {
      return parsed as RawContextBookDocument;
    }
    return null;
  } catch {
    return null;
  }
}

function extractEntries(
  document: RawContextBookDocument,
  sourcePath: string,
  warn?: (message: string) => void,
): NormalizedContextBookEntry[] {
  const rawEntries = Array.isArray(document)
    ? document
    : Array.isArray(document.entries)
      ? document.entries
      : [];
  if (!rawEntries.length) {
    return [];
  }

  const normalized: NormalizedContextBookEntry[] = [];
  for (const [index, rawEntry] of rawEntries.entries()) {
    if (!isRecord(rawEntry)) {
      warn?.(`skipping context book entry ${sourcePath}#${index + 1} - entry must be an object`);
      continue;
    }

    const enabled = parseBoolean(rawEntry.enabled, true);
    const alwaysActive = parseBoolean(rawEntry.alwaysActive, false);
    if (!enabled || !alwaysActive) {
      continue;
    }

    const content = typeof rawEntry.content === "string" ? rawEntry.content.trim() : "";
    if (!content) {
      warn?.(`skipping context book entry ${sourcePath}#${index + 1} - missing content`);
      continue;
    }

    const positionValue =
      typeof rawEntry.position === "string" ? rawEntry.position.trim().toLowerCase() : "";
    const position = positionValue || "after_context";
    if (!SUPPORTED_BOOTSTRAP_POSITIONS.has(position)) {
      warn?.(
        `skipping context book entry ${sourcePath}#${index + 1} - unsupported position "${position}" in bootstrap-backed Context Book v1`,
      );
      continue;
    }

    const entryName = normalizeEntryName(rawEntry.name, sourcePath, index);
    normalized.push({
      syntheticName: `CONTEXT_BOOK:${entryName}`,
      syntheticPath: `${sourcePath}#${slugify(entryName)}`,
      content,
      order: parseOrder(rawEntry.order),
      sourcePath,
      sourceIndex: index,
    });
  }

  normalized.sort((a, b) => {
    if (a.order !== b.order) {
      return b.order - a.order;
    }
    if (a.sourcePath !== b.sourcePath) {
      return a.sourcePath.localeCompare(b.sourcePath);
    }
    return a.sourceIndex - b.sourceIndex;
  });
  return normalized;
}

async function readContextBookFile(params: {
  workspaceDir: string;
  filePath: string;
  warn?: (message: string) => void;
}): Promise<string | undefined> {
  const opened = await openBoundaryFile({
    absolutePath: params.filePath,
    rootPath: params.workspaceDir,
    boundaryLabel: "workspace root",
    maxBytes: CONTEXT_BOOK_MAX_FILE_BYTES,
  });
  if (!opened.ok) {
    params.warn?.(
      `skipping context book ${params.filePath} - ${opened.reason === "validation" ? "invalid file" : opened.reason}`,
    );
    return undefined;
  }

  try {
    return syncFs.readFileSync(opened.fd, "utf-8");
  } catch {
    params.warn?.(`skipping context book ${params.filePath} - failed to read file`);
    return undefined;
  } finally {
    syncFs.closeSync(opened.fd);
  }
}

function shouldSkipContextBooks(params: {
  sessionKey?: string;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): boolean {
  if (params.contextMode === "lightweight") {
    return true;
  }
  if (params.runKind === "heartbeat" || params.runKind === "cron") {
    return true;
  }
  const sessionKey = params.sessionKey;
  if (!sessionKey) {
    return false;
  }
  // Keep current prompt minimization behavior for cron/subagent sessions until
  // sessionKinds-aware Context Book routing lands.
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey);
}

export async function loadContextBookBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey?: string;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
  warn?: (message: string) => void;
}): Promise<WorkspaceBootstrapFile[]> {
  if (shouldSkipContextBooks(params)) {
    return [];
  }

  const workspaceDir = resolveUserPath(params.workspaceDir);
  const contextBooksDir = path.join(workspaceDir, CONTEXT_BOOKS_DIRNAME);
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(contextBooksDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    params.warn?.(`failed to read context-books directory: ${contextBooksDir}`);
    return [];
  }

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => CONTEXT_BOOK_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .toSorted((a, b) => a.localeCompare(b));

  const normalizedEntries: NormalizedContextBookEntry[] = [];
  for (const fileName of files) {
    const filePath = path.join(contextBooksDir, fileName);
    const raw = await readContextBookFile({
      workspaceDir,
      filePath,
      warn: params.warn,
    });
    if (!raw) {
      continue;
    }
    const parsed = parseContextBookDocument(raw, filePath);
    if (!parsed) {
      params.warn?.(`skipping context book ${filePath} - invalid YAML/JSON document`);
      continue;
    }
    normalizedEntries.push(...extractEntries(parsed, filePath, params.warn));
  }

  normalizedEntries.sort((a, b) => {
    if (a.order !== b.order) {
      return b.order - a.order;
    }
    if (a.sourcePath !== b.sourcePath) {
      return a.sourcePath.localeCompare(b.sourcePath);
    }
    return a.sourceIndex - b.sourceIndex;
  });

  return normalizedEntries.map((entry) => ({
    name: entry.syntheticName,
    path: entry.syntheticPath,
    content: entry.content,
    missing: false,
  }));
}
