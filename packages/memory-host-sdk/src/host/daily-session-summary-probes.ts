import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readRememberedDailyMemoryFile, listRecentDailyMemoryFiles } from "./daily-files.js";
import {
  isCrossPlatformAbsolutePath,
  parseDailyMemoryFileName,
  parseDailyMemoryPathInfo,
} from "./daily-paths.js";
import {
  readSessionSummaryProbePrefixFromFd,
  readSessionSummaryProbePrefixFromFile,
} from "./daily-session-summary-io.js";
import {
  isLikelyMissingSessionSummaryDailyMemory,
  normalizeSessionSummarySnippet,
} from "./daily-session-summary-rules.js";
import { isSessionSummaryDailyMemory } from "./daily-session-summary.js";
import { openBoundaryFile, resolveBoundaryPath } from "./openclaw-runtime-io.js";

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

function isWindowsStyleSessionSummaryAbsolutePath(normalizedPath: string): boolean {
  return /^[a-z]:\//i.test(normalizedPath);
}

function normalizeSessionSummaryWorkspaceComparablePath(rawPath: string): string {
  const normalizedPath = normalizeSessionSummaryPath(rawPath);
  if (!isWindowsStyleSessionSummaryAbsolutePath(normalizedPath)) {
    return normalizedPath;
  }
  return normalizedPath.toLowerCase();
}

function resolveSessionSummaryProbeInputPath(workspaceDir: string, filePath: string): string {
  const normalizedPath = normalizeSessionSummaryPath(filePath);
  if (isCrossPlatformAbsolutePath(normalizedPath)) {
    const normalizedWorkspaceDir = normalizeSessionSummaryPath(path.resolve(workspaceDir));
    const comparablePath = normalizeSessionSummaryWorkspaceComparablePath(normalizedPath);
    const comparableWorkspaceDir =
      normalizeSessionSummaryWorkspaceComparablePath(normalizedWorkspaceDir);
    if (
      comparablePath === comparableWorkspaceDir ||
      comparablePath.startsWith(`${comparableWorkspaceDir}/`)
    ) {
      const relativePath = normalizeSessionSummaryPath(
        normalizedPath.slice(normalizedWorkspaceDir.length + 1),
      );
      if (
        !relativePath ||
        relativePath.startsWith("..") ||
        isCrossPlatformAbsolutePath(relativePath)
      ) {
        return "";
      }
      return relativePath;
    }
    return "";
  }
  const resolvedPath = path.resolve(workspaceDir, normalizedPath);
  const relativePath = normalizeSessionSummaryPath(path.relative(workspaceDir, resolvedPath));
  if (!relativePath || relativePath.startsWith("..") || isCrossPlatformAbsolutePath(relativePath)) {
    return "";
  }
  return relativePath;
}

async function closeBoundaryFd(fd: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fsSync.close(fd, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readSessionSummaryWorkspaceFile(params: {
  workspaceDir: string;
  filePath: string;
}): Promise<SessionSummaryWorkspaceReadResult> {
  const relativePath = resolveSessionSummaryProbeInputPath(params.workspaceDir, params.filePath);
  if (!relativePath) {
    return { kind: "blocked" };
  }
  const opened = await openBoundaryFile({
    absolutePath: path.join(params.workspaceDir, relativePath),
    rootPath: params.workspaceDir,
    boundaryLabel: "workspace root",
  });
  if (!opened.ok) {
    return {
      kind: opened.reason === "path" ? "missing" : "blocked",
    };
  }
  try {
    return {
      kind: "content",
      raw: await readSessionSummaryProbePrefixFromFd(opened.fd),
      absolutePath: opened.path,
    };
  } finally {
    await closeBoundaryFd(opened.fd);
  }
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
    if (params.kind === "file") {
      const handle = await fs.open(params.absolutePath, "r");
      try {
        const stats = await handle.stat();
        const raw = await readSessionSummaryProbePrefixFromFd(handle.fd);
        const contentHash = createHash("sha1").update(raw).digest("hex");
        return `present:${params.kind}:${stats.size}:${stats.mtimeMs}:${contentHash}`;
      } finally {
        await handle.close();
      }
    }
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
  const relativePaths = normalizedPath.includes("/")
    ? [normalizedPath]
    : [path.posix.join("memory", path.posix.basename(normalizedPath)), normalizedPath];
  const seenRelativePaths = new Set<string>();
  const candidates: Array<{ absolutePath: string; relativePath: string }> = [];
  for (const relativePath of relativePaths) {
    const normalizedRelativePath = normalizeSessionSummaryPath(relativePath);
    if (seenRelativePaths.has(normalizedRelativePath)) {
      continue;
    }
    seenRelativePaths.add(normalizedRelativePath);
    candidates.push({
      absolutePath: path.resolve(workspaceDir, normalizedRelativePath),
      relativePath: normalizedRelativePath,
    });
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

function resolveRememberedSummaryFileNameForInputPath(filePath: string): string | null {
  const normalizedPath = normalizeSessionSummaryPath(filePath);
  const parsed = parseDailyMemoryPathInfo(normalizedPath);
  if (parsed) {
    if (
      normalizedPath === parsed.fileName ||
      (parsed.dir === "memory" && normalizedPath === `memory/${parsed.fileName}`)
    ) {
      return parsed.fileName;
    }
  }
  const relativeFromMemory = normalizedPath.match(/(?:^|.*\/)(memory\/[^/]+)$/)?.[1];
  if (!relativeFromMemory) {
    return null;
  }
  const relativeParsed = parseDailyMemoryPathInfo(relativeFromMemory);
  if (!relativeParsed || relativeParsed.dir !== "memory") {
    return null;
  }
  return relativeParsed.fileName;
}

function canUseRememberedSummaryInputPathAlias(params: {
  normalizedPath: string;
  probePaths: Array<{ absolutePath: string; relativePath: string }>;
}): boolean {
  if (params.probePaths.length > 0) {
    return true;
  }
  return (
    isWindowsStyleSessionSummaryAbsolutePath(params.normalizedPath) &&
    !path.isAbsolute(params.normalizedPath)
  );
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
      resolvedDir = (
        await resolveBoundaryPath({
          absolutePath: absoluteDir,
          rootPath: params.workspaceDir,
          boundaryLabel: "workspace root",
        })
      ).canonicalPath;
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

async function filterDailyMemoryFilesBySessionSummary(params: {
  filePaths: string[];
  includeSessionSummaries: boolean;
  tolerateReadErrors?: boolean;
}): Promise<string[]> {
  const tolerateReadErrors = params.tolerateReadErrors !== false;
  const keptPaths: string[] = [];
  for (const filePath of params.filePaths) {
    const raw = await readSessionSummaryProbePrefixFromFile(filePath).catch((error: unknown) => {
      if (tolerateReadErrors && isBenignSessionSummaryDailyMemoryProbeError(error)) {
        return null;
      }
      throw error;
    });
    if (raw === null) {
      continue;
    }
    const isSummary = isSessionSummaryDailyMemory(raw);
    if (isSummary === params.includeSessionSummaries) {
      keptPaths.push(filePath);
    }
  }
  return keptPaths;
}

export async function filterOutSessionSummaryDailyMemoryFiles(
  filePaths: string[],
  opts?: { tolerateReadErrors?: boolean },
): Promise<string[]> {
  return await filterDailyMemoryFilesBySessionSummary({
    filePaths,
    includeSessionSummaries: false,
    tolerateReadErrors: opts?.tolerateReadErrors,
  });
}

export async function filterSessionSummaryDailyMemoryFiles(
  filePaths: string[],
  opts?: { tolerateReadErrors?: boolean },
): Promise<string[]> {
  return await filterDailyMemoryFilesBySessionSummary({
    filePaths,
    includeSessionSummaries: true,
    tolerateReadErrors: opts?.tolerateReadErrors,
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
  const cached = params.cache.get(normalizedPath);
  if (cached != null) {
    return cached;
  }
  let sawExistingCandidate = false;
  const probePaths = buildSessionSummaryDailyMemoryProbePaths(params.workspaceDir, params.filePath);
  const missingCandidateRelativePaths = new Set<string>();
  for (const candidate of probePaths) {
    const candidateCached = params.cache.get(candidate.relativePath);
    if (candidateCached != null) {
      if (candidateCached) {
        params.cache.set(normalizedPath, true);
        return true;
      }
      sawExistingCandidate = true;
      params.cache.set(normalizedPath, false);
      continue;
    }
    const relativeToWorkspace = path.relative(params.workspaceDir, candidate.absolutePath);
    if (
      relativeToWorkspace.startsWith("..") ||
      isCrossPlatformAbsolutePath(relativeToWorkspace) ||
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
      await recordSessionSummaryDailyMemoryDependency({
        kind: "file",
        absolutePath: candidate.absolutePath,
        recordDependency: params.recordDependency,
      });
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
    ? (resolveRememberedSummaryFileNameForProbePaths(probePaths) ??
      (canUseRememberedSummaryInputPathAlias({ normalizedPath, probePaths })
        ? resolveRememberedSummaryFileNameForInputPath(params.filePath)
        : null))
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
