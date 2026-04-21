import fs from "node:fs/promises";
import path from "node:path";
import { listRecentDailyMemoryFiles, readRememberedDailyMemoryFile } from "./daily-files.js";
import { parseDailyMemoryFileName, parseDailyMemoryPathInfo } from "./daily-paths.js";
export {
  isSessionSummaryDailyMemory,
  SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
} from "./daily-session-summary.js";
import {
  isSessionSummaryDailyMemory,
  SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
} from "./daily-session-summary.js";
const SESSION_SUMMARY_SNIPPET_TRANSCRIPT_LINE_RE = /^(?:assistant|user|system):\s+\S/;
const LEGACY_SESSION_SUMMARY_TRANSCRIPT_START_LINE_MIN = 8;

export type SessionSummaryDailyMemoryDependency = {
  kind: "file" | "directory";
  absolutePath: string;
  token: string;
};

type SessionSummaryDailyMemoryDependencyRecorder = (
  dependency: SessionSummaryDailyMemoryDependency,
) => void;

type SessionSummaryWorkspaceReadResult =
  | { kind: "content"; raw: string; absolutePath: string }
  | { kind: "missing" }
  | { kind: "blocked" };

function normalizeSessionSummaryPath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeSessionSummarySnippet(rawSnippet: string | undefined): string {
  return rawSnippet?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function hasExplicitSessionSummaryMetadataSnippetMarkers(snippet: string): boolean {
  return (
    hasStrongSessionSummaryMetadataSnippetMarkers(snippet) ||
    snippet.includes("## conversation summary")
  );
}

function hasStrongSessionSummaryMetadataSnippetMarkers(snippet: string): boolean {
  return (
    snippet.includes("# session:") ||
    /\bsession key\s*:/i.test(snippet) ||
    /\bsession id\s*:/i.test(snippet)
  );
}

function hasTranscriptLikeSessionSummarySnippet(snippet: string): boolean {
  return SESSION_SUMMARY_SNIPPET_TRANSCRIPT_LINE_RE.test(snippet);
}

export function isLikelySessionSummaryDailyMemorySnippet(snippet?: string): boolean {
  const normalizedSnippet = normalizeSessionSummarySnippet(snippet);
  return (
    hasExplicitSessionSummaryMetadataSnippetMarkers(normalizedSnippet) ||
    hasTranscriptLikeSessionSummarySnippet(normalizedSnippet)
  );
}

function hasLikelySessionSummarySlug(filePath: string): boolean {
  const parsed = parseDailyMemoryPathInfo(filePath);
  if (!parsed || parsed.canonical || !parsed.slug) {
    return false;
  }
  return /\b(?:session|reset)\b/i.test(parsed.slug.replace(/[._-]+/g, " "));
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveSessionSummaryProbeInputPath(workspaceDir: string, filePath: string): string {
  const normalizedPath = normalizeSessionSummaryPath(filePath);
  const resolvedPath = path.resolve(workspaceDir, normalizedPath);
  const relativePath = normalizeSessionSummaryPath(path.relative(workspaceDir, resolvedPath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "";
  }
  return relativePath;
}

async function resolveWorkspaceCanonicalPath(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<string | null> {
  const rootPath = path.resolve(params.workspaceDir);
  const absolutePath = path.resolve(rootPath, params.relativePath);
  if (!isPathInside(rootPath, absolutePath)) {
    return null;
  }
  const rootRealPath = await fs.realpath(rootPath);
  const realPath = await fs.realpath(absolutePath);
  if (!isPathInside(rootRealPath, realPath)) {
    return null;
  }
  return realPath;
}

async function readSessionSummaryWorkspaceFile(params: {
  workspaceDir: string;
  filePath: string;
}): Promise<SessionSummaryWorkspaceReadResult> {
  const relativePath = resolveSessionSummaryProbeInputPath(params.workspaceDir, params.filePath);
  if (!relativePath) {
    return { kind: "blocked" };
  }
  let absolutePath: string | null;
  try {
    absolutePath = await resolveWorkspaceCanonicalPath({
      workspaceDir: params.workspaceDir,
      relativePath,
    });
  } catch (error) {
    if (isBenignSessionSummaryDailyMemoryProbeError(error)) {
      return { kind: "missing" };
    }
    throw error;
  }
  if (!absolutePath) {
    return { kind: "blocked" };
  }
  return {
    kind: "content",
    raw: await fs.readFile(absolutePath, "utf-8"),
    absolutePath,
  };
}

async function hasSiblingDailyMemoryVariantSnippetMatch(params: {
  workspaceDir: string;
  filePath: string;
  snippet?: string;
  recordDependency?: SessionSummaryDailyMemoryDependencyRecorder;
}): Promise<boolean> {
  const normalizedSnippet = normalizeSessionSummarySnippet(params.snippet);
  if (!normalizedSnippet) {
    return false;
  }
  const probeRoots = buildSessionSummaryDailyMemoryProbePaths(params.workspaceDir, params.filePath)
    .map((candidate) => parseDailyMemoryPathInfo(candidate.relativePath))
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  if (probeRoots.length === 0) {
    return false;
  }
  const seenRoots = new Set<string>();
  for (const root of probeRoots) {
    const rootKey = `${root.dir}\u0000${root.day}\u0000${root.fileName}`;
    if (seenRoots.has(rootKey)) {
      continue;
    }
    seenRoots.add(rootKey);
    const absoluteDir = path.resolve(params.workspaceDir, root.dir === "." ? "" : root.dir);
    let resolvedDir: string;
    try {
      const relativeDir = normalizeSessionSummaryPath(path.relative(params.workspaceDir, absoluteDir));
      const canonicalDir = await resolveWorkspaceCanonicalPath({
        workspaceDir: params.workspaceDir,
        relativePath: relativeDir,
      });
      if (!canonicalDir) {
        continue;
      }
      resolvedDir = canonicalDir;
    } catch {
      continue;
    }
    let dirEntries;
    try {
      dirEntries = await fs.readdir(resolvedDir, { withFileTypes: true });
      await recordSessionSummaryDailyMemoryDependency({
        kind: "directory",
        absolutePath: resolvedDir,
        recordDependency: params.recordDependency,
      });
    } catch (error) {
      if (isBenignSessionSummaryDailyMemoryProbeError(error)) {
        await recordSessionSummaryDailyMemoryDependency({
          kind: "directory",
          absolutePath: resolvedDir,
          recordDependency: params.recordDependency,
          missingError: error,
        });
        continue;
      }
      throw error;
    }
    for (const dirEntry of dirEntries) {
      if (!dirEntry.isFile()) {
        continue;
      }
      const sibling = parseDailyMemoryFileName(dirEntry.name);
      if (!sibling || sibling.day !== root.day || sibling.fileName === root.fileName) {
        continue;
      }
      const siblingPath =
        root.dir === "." ? sibling.fileName : path.posix.join(root.dir, sibling.fileName);
      const siblingRead = await readSessionSummaryWorkspaceFile({
        workspaceDir: params.workspaceDir,
        filePath: siblingPath,
      });
      if (siblingRead.kind !== "content") {
        continue;
      }
      try {
        await recordSessionSummaryDailyMemoryDependency({
          kind: "file",
          absolutePath: siblingRead.absolutePath,
          recordDependency: params.recordDependency,
        });
        if (isSessionSummaryDailyMemory(siblingRead.raw)) {
          continue;
        }
        if (normalizeSessionSummarySnippet(siblingRead.raw).includes(normalizedSnippet)) {
          return true;
        }
      } catch (error) {
        if (isBenignSessionSummaryDailyMemoryProbeError(error)) {
          await recordSessionSummaryDailyMemoryDependency({
            kind: "file",
            absolutePath: siblingRead.absolutePath,
            recordDependency: params.recordDependency,
            missingError: error,
          });
          continue;
        }
        throw error;
      }
    }
  }
  return false;
}

export async function filterOutSessionSummaryDailyMemoryFiles(
  filePaths: string[],
  opts?: { tolerateReadErrors?: boolean },
): Promise<string[]> {
  const tolerateReadErrors = opts?.tolerateReadErrors !== false;
  const keptPaths: string[] = [];
  for (const filePath of filePaths) {
    const raw = await fs.readFile(filePath, "utf-8").catch((error: unknown) => {
      if (tolerateReadErrors && isBenignSessionSummaryDailyMemoryProbeError(error)) {
        return null;
      }
      throw error;
    });
    if (raw === null || isSessionSummaryDailyMemory(raw)) {
      continue;
    }
    keptPaths.push(filePath);
  }
  return keptPaths;
}

export const filterSessionSummaryDailyMemoryFiles = filterOutSessionSummaryDailyMemoryFiles;

export function isLikelyMissingSessionSummaryDailyMemory(params: {
  filePath: string;
  snippet?: string;
  startLine?: number;
  hasSiblingVariantMatch?: boolean;
  rememberedSessionSummary?: boolean;
  allowLegacySemanticSlugTranscriptFallback?: boolean;
}): boolean {
  const parsed = parseDailyMemoryPathInfo(params.filePath);
  if (!parsed) {
    return false;
  }
  if (params.rememberedSessionSummary) {
    return true;
  }
  const snippet = normalizeSessionSummarySnippet(params.snippet);
  if (parsed.canonical) {
    return hasStrongSessionSummaryMetadataSnippetMarkers(snippet);
  }
  if (params.hasSiblingVariantMatch) {
    return false;
  }
  const startLine = Math.max(1, Math.floor(params.startLine ?? 0));
  const hasLegacySemanticSlugTranscriptFallback =
    params.allowLegacySemanticSlugTranscriptFallback === true &&
    startLine >= LEGACY_SESSION_SUMMARY_TRANSCRIPT_START_LINE_MIN &&
    hasTranscriptLikeSessionSummarySnippet(snippet);
  return (
    hasExplicitSessionSummaryMetadataSnippetMarkers(snippet) ||
    (hasLikelySessionSummarySlug(params.filePath) &&
      hasTranscriptLikeSessionSummarySnippet(snippet)) ||
    hasLegacySemanticSlugTranscriptFallback
  );
}

export function isBenignSessionSummaryDailyMemoryProbeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
}

function buildSessionSummaryDailyMemoryDependencyTokenFromError(error: unknown): string | null {
  if (!isBenignSessionSummaryDailyMemoryProbeError(error)) {
    return null;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "missing";
  return `missing:${code}`;
}

async function readSessionSummaryDailyMemoryDependencyToken(params: {
  kind: SessionSummaryDailyMemoryDependency["kind"];
  absolutePath: string;
}): Promise<string> {
  try {
    const stats = await fs.stat(params.absolutePath);
    return `present:${params.kind}:${stats.size}:${stats.mtimeMs}`;
  } catch (error) {
    const missingToken = buildSessionSummaryDailyMemoryDependencyTokenFromError(error);
    if (missingToken !== null) {
      return missingToken;
    }
    throw error;
  }
}

async function recordSessionSummaryDailyMemoryDependency(params: {
  kind: SessionSummaryDailyMemoryDependency["kind"];
  absolutePath: string;
  recordDependency?: SessionSummaryDailyMemoryDependencyRecorder;
  missingError?: unknown;
}): Promise<void> {
  if (!params.recordDependency) {
    return;
  }
  const token =
    params.missingError !== undefined
      ? buildSessionSummaryDailyMemoryDependencyTokenFromError(params.missingError)
      : await readSessionSummaryDailyMemoryDependencyToken({
          kind: params.kind,
          absolutePath: params.absolutePath,
        });
  if (token === null) {
    return;
  }
  params.recordDependency({
    kind: params.kind,
    absolutePath: params.absolutePath,
    token,
  });
}

export async function areSessionSummaryDailyMemoryDependenciesCurrent(
  dependencies: SessionSummaryDailyMemoryDependency[],
): Promise<boolean> {
  for (const dependency of dependencies) {
    if (
      (await readSessionSummaryDailyMemoryDependencyToken({
        kind: dependency.kind,
        absolutePath: dependency.absolutePath,
      })) !== dependency.token
    ) {
      return false;
    }
  }
  return true;
}

export function buildSessionSummaryDailyMemoryProbePaths(
  workspaceDir: string,
  filePath: string,
): Array<{ absolutePath: string; relativePath: string }> {
  const normalizedPath = resolveSessionSummaryProbeInputPath(workspaceDir, filePath);
  if (!normalizedPath) {
    return [];
  }
  const relativePaths = [normalizedPath];
  if (!normalizedPath.includes("/")) {
    relativePaths.push(path.posix.join("memory", path.posix.basename(normalizedPath)));
  }
  const seenRelativePaths = new Set<string>();
  const candidates: Array<{ absolutePath: string; relativePath: string }> = [];
  for (const relativePath of relativePaths) {
    const normalizedRelativePath = normalizeSessionSummaryPath(relativePath);
    if (seenRelativePaths.has(normalizedRelativePath)) {
      continue;
    }
    seenRelativePaths.add(normalizedRelativePath);
    const absolutePath = path.resolve(workspaceDir, normalizedRelativePath);
    candidates.push({ absolutePath, relativePath: normalizedRelativePath });
  }
  return candidates;
}

function cacheProbeAliasResults(params: {
  cache: Map<string, boolean>;
  candidates: Array<{ absolutePath: string; relativePath: string }>;
  absolutePath: string;
  value: boolean;
}): void {
  for (const candidate of params.candidates) {
    if (candidate.absolutePath === params.absolutePath) {
      params.cache.set(candidate.relativePath, params.value);
    }
  }
}

function resolveRememberedSummaryFileNameForProbePaths(
  candidates: Array<{ absolutePath: string; relativePath: string }>,
): string | null {
  for (const candidate of candidates) {
    const normalizedRelativePath = normalizeSessionSummaryPath(candidate.relativePath);
    const parsed = parseDailyMemoryPathInfo(normalizedRelativePath);
    if (!parsed) {
      continue;
    }
    if (
      normalizedRelativePath === parsed.fileName ||
      (parsed.dir === "memory" && normalizedRelativePath === `memory/${parsed.fileName}`)
    ) {
      return parsed.fileName;
    }
  }
  return null;
}

async function refreshRememberedSummaryEntryForMissingProbe(params: {
  workspaceDir: string;
  fileName: string;
}): Promise<Awaited<ReturnType<typeof readRememberedDailyMemoryFile>>> {
  const memoryDir = path.join(params.workspaceDir, "memory");
  const rememberedEntry = await readRememberedDailyMemoryFile({
    memoryDir,
    fileName: params.fileName,
  });
  if (rememberedEntry?.sessionSummary !== true) {
    return rememberedEntry;
  }
  const parsed = parseDailyMemoryFileName(params.fileName);
  if (parsed) {
    try {
      const scannedEntries = await listRecentDailyMemoryFiles({
        memoryDir,
        days: [parsed.day],
        persistIndex: false,
      });
      if (scannedEntries.length === 0) {
        return rememberedEntry;
      }
      await listRecentDailyMemoryFiles({
        memoryDir,
        days: [parsed.day],
      });
    } catch (error) {
      if (!isBenignSessionSummaryDailyMemoryProbeError(error)) {
        throw error;
      }
      return rememberedEntry;
    }
  }
  return await readRememberedDailyMemoryFile({
    memoryDir,
    fileName: params.fileName,
  });
}

export async function isSessionSummaryDailyMemoryPath(params: {
  workspaceDir: string;
  filePath: string;
  cache: Map<string, boolean>;
  snippet?: string;
  startLine?: number;
  recordDependency?: SessionSummaryDailyMemoryDependencyRecorder;
  allowLegacySemanticSlugTranscriptFallback?: boolean;
}): Promise<boolean> {
  const normalizedPath = normalizeSessionSummaryPath(params.filePath);
  const probeInputPath = resolveSessionSummaryProbeInputPath(params.workspaceDir, params.filePath);
  if (!probeInputPath) {
    return false;
  }
  const cached = params.cache.get(normalizedPath);
  if (cached != null) {
    return cached;
  }
  let sawExistingCandidate = false;
  const probePaths = buildSessionSummaryDailyMemoryProbePaths(params.workspaceDir, probeInputPath);
  const missingCandidateRelativePaths = new Set<string>();
  for (const candidate of probePaths) {
    const candidateCached = params.cache.get(candidate.relativePath);
    if (candidateCached != null) {
      if (candidateCached) {
        params.cache.set(normalizedPath, true);
        return true;
      }
      continue;
    }
    const relativeToWorkspace = path.relative(params.workspaceDir, candidate.absolutePath);
    if (
      relativeToWorkspace.startsWith("..") ||
      path.isAbsolute(relativeToWorkspace) ||
      relativeToWorkspace.length === 0
    ) {
      missingCandidateRelativePaths.add(candidate.relativePath);
      continue;
    }
    const candidateRead = await readSessionSummaryWorkspaceFile({
      workspaceDir: params.workspaceDir,
      filePath: candidate.relativePath,
    });
    if (candidateRead.kind === "blocked") {
      params.cache.set(normalizedPath, false);
      return false;
    }
    if (candidateRead.kind === "missing") {
      missingCandidateRelativePaths.add(candidate.relativePath);
      continue;
    }
    try {
      sawExistingCandidate = true;
      await recordSessionSummaryDailyMemoryDependency({
        kind: "file",
        absolutePath: candidateRead.absolutePath,
        recordDependency: params.recordDependency,
      });
      const isSummary = isSessionSummaryDailyMemory(candidateRead.raw);
      cacheProbeAliasResults({
        cache: params.cache,
        candidates: probePaths,
        absolutePath: candidate.absolutePath,
        value: isSummary,
      });
      if (isSummary) {
        params.cache.set(normalizedPath, true);
        return true;
      }
    } catch (error) {
      if (isBenignSessionSummaryDailyMemoryProbeError(error)) {
        await recordSessionSummaryDailyMemoryDependency({
          kind: "file",
          absolutePath: candidate.absolutePath,
          recordDependency: params.recordDependency,
          missingError: error,
        });
        missingCandidateRelativePaths.add(candidate.relativePath);
        continue;
      }
      throw error;
    }
  }
  const hasSiblingVariantMatch =
    !sawExistingCandidate &&
    (await hasSiblingDailyMemoryVariantSnippetMatch({
      workspaceDir: params.workspaceDir,
      filePath: normalizedPath,
      snippet: params.snippet,
      recordDependency: params.recordDependency,
    }));
  const rememberedSessionSummaryFileName = !sawExistingCandidate
    ? resolveRememberedSummaryFileNameForProbePaths(probePaths)
    : null;
  const rememberedEntry = rememberedSessionSummaryFileName
    ? await refreshRememberedSummaryEntryForMissingProbe({
        workspaceDir: params.workspaceDir,
        fileName: rememberedSessionSummaryFileName,
      })
    : null;
  const isDeletedSummaryFallback =
    !sawExistingCandidate &&
    isLikelyMissingSessionSummaryDailyMemory({
      filePath: normalizedPath,
      snippet: params.snippet,
      startLine: params.startLine,
      hasSiblingVariantMatch,
      rememberedSessionSummary: rememberedEntry?.sessionSummary === true,
      allowLegacySemanticSlugTranscriptFallback: params.allowLegacySemanticSlugTranscriptFallback,
    });
  const cacheableDeletedSummaryFallback =
    isDeletedSummaryFallback && rememberedEntry?.sessionSummary === true;
  if (cacheableDeletedSummaryFallback) {
    for (const relativePath of missingCandidateRelativePaths) {
      params.cache.set(relativePath, true);
    }
    params.cache.set(normalizedPath, true);
  }
  return isDeletedSummaryFallback;
}
