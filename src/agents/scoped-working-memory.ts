import syncFs from "node:fs";
import path from "node:path";
import { openBoundaryFile } from "../infra/boundary-file-read.js";
import { resolveUserPath } from "../utils.js";
import type { BootstrapInjectionStat } from "./bootstrap-budget.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";

const MAX_SCOPED_WORKING_MEMORY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_SCOPED_WORKING_MEMORY_MAX_CHARS = 10_000;
const MIN_SCOPED_WORKING_MEMORY_BUDGET_CHARS = 256;
const SCOPED_WORKING_MEMORY_ROOT = ".openclaw/working-memory";

export function getScopedWorkingMemoryRoot(): string {
  return SCOPED_WORKING_MEMORY_ROOT;
}

export function defaultCronWorkingMemoryPath(jobId: string): string {
  const safeJobId = jobId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.posix.join(SCOPED_WORKING_MEMORY_ROOT, "cron", `${safeJobId || "job"}.md`);
}

export function normalizeScopedWorkingMemoryPath(relativePath: string): string {
  const trimmed = relativePath.trim();
  if (!trimmed) {
    throw new Error("workingMemoryPath must not be empty");
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\\\")) {
    throw new Error("workingMemoryPath must be a workspace-relative path");
  }
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("workingMemoryPath must stay inside the workspace");
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("workingMemoryPath must point to a markdown file");
  }
  const scopedRootPrefix = `${SCOPED_WORKING_MEMORY_ROOT}/`;
  if (normalized !== SCOPED_WORKING_MEMORY_ROOT && !normalized.startsWith(scopedRootPrefix)) {
    throw new Error(`workingMemoryPath must live under ${SCOPED_WORKING_MEMORY_ROOT}/`);
  }
  return normalized;
}

function isMissingFileError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function clampToBudget(content: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  return content.length <= maxChars ? content : content.slice(0, maxChars);
}

export type ScopedWorkingMemoryStatus = "loaded" | "missing" | "present-not-injected" | "rejected";

export type ScopedWorkingMemoryReason = "path" | "validation" | "io" | "budget";

export type ScopedWorkingMemoryFile = {
  path: string;
  status: ScopedWorkingMemoryStatus;
  rawChars: number;
  injectedChars: number;
  reason?: ScopedWorkingMemoryReason;
};

export async function loadScopedWorkingMemoryContextFile(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<{
  contextFile?: EmbeddedContextFile;
  file: ScopedWorkingMemoryFile;
}> {
  const workspaceDir = resolveUserPath(params.workspaceDir);
  const relativePath = normalizeScopedWorkingMemoryPath(params.relativePath);
  const absolutePath = path.resolve(workspaceDir, relativePath);

  const opened = await openBoundaryFile({
    absolutePath,
    rootPath: workspaceDir,
    boundaryLabel: "workspace root",
    maxBytes: MAX_SCOPED_WORKING_MEMORY_BYTES,
  });
  if (!opened.ok) {
    const status =
      opened.reason === "path" && isMissingFileError(opened.error) ? "missing" : "rejected";
    return {
      file: {
        path: relativePath,
        status,
        rawChars: 0,
        injectedChars: 0,
        ...(status === "rejected" ? { reason: opened.reason } : {}),
      },
    };
  }

  try {
    const content = syncFs.readFileSync(opened.fd, "utf-8");
    return {
      contextFile: { path: relativePath, content },
      file: {
        path: relativePath,
        status: "loaded",
        rawChars: content.length,
        injectedChars: content.length,
      },
    };
  } finally {
    syncFs.closeSync(opened.fd);
  }
}

export function fitScopedWorkingMemoryContextFileToBudget(params: {
  loaded: {
    contextFile?: EmbeddedContextFile;
    file: ScopedWorkingMemoryFile;
  };
  maxChars?: number;
  totalMaxChars?: number;
  warn?: (message: string) => void;
}): {
  contextFile?: EmbeddedContextFile;
  file: ScopedWorkingMemoryFile;
} {
  const contextFile = params.loaded.contextFile;
  const file = params.loaded.file;
  if (!contextFile || file.status !== "loaded") {
    return params.loaded;
  }

  const requestedMaxChars =
    typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars > 0
      ? Math.floor(params.maxChars)
      : DEFAULT_SCOPED_WORKING_MEMORY_MAX_CHARS;
  const requestedTotalMaxChars =
    typeof params.totalMaxChars === "number" && Number.isFinite(params.totalMaxChars)
      ? Math.max(0, Math.floor(params.totalMaxChars))
      : requestedMaxChars;
  const availableChars = Math.min(requestedMaxChars, requestedTotalMaxChars);
  const rawContent = contextFile.content;
  const rawChars = rawContent.length;

  if (requestedTotalMaxChars < MIN_SCOPED_WORKING_MEMORY_BUDGET_CHARS) {
    params.warn?.(
      `scoped working memory ${file.path} is available but only ${requestedTotalMaxChars} chars of prompt budget remain (<${MIN_SCOPED_WORKING_MEMORY_BUDGET_CHARS}); skipping injection`,
    );
    return {
      file: {
        path: file.path,
        status: "present-not-injected",
        rawChars,
        injectedChars: 0,
        reason: "budget",
      },
    };
  }

  const injectedContent = clampToBudget(rawContent, availableChars);
  if (injectedContent.length < rawChars) {
    params.warn?.(
      `scoped working memory ${file.path} is ${rawChars} chars (limit ${availableChars}); truncating in injected context`,
    );
  }

  return {
    contextFile: {
      path: contextFile.path,
      content: injectedContent,
    },
    file: {
      path: file.path,
      status: "loaded",
      rawChars,
      injectedChars: injectedContent.length,
    },
  };
}

export function buildScopedWorkingMemoryInjectionStats(
  files: ScopedWorkingMemoryFile[],
): BootstrapInjectionStat[] {
  return files.map((file) => ({
    name: path.posix.basename(file.path) || file.path,
    path: file.path,
    missing: file.status === "missing",
    rawChars: file.rawChars,
    injectedChars: file.injectedChars,
    truncated:
      file.status !== "missing" && file.status !== "rejected" && file.injectedChars < file.rawChars,
  }));
}
