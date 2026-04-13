import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { isWindowsDrivePath } from "../infra/archive-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { sameFileIdentity } from "../infra/file-identity.js";
import { writeFileFromPathWithinRoot } from "../infra/fs-safe.js";
import { assertCanonicalPathWithinBase } from "../infra/install-safe-path.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { isWithinDir } from "../infra/path-safety.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import { extractArchive } from "./skills-install-extract.js";
import { formatInstallFailureMessage } from "./skills-install-output.js";
import type { SkillInstallResult } from "./skills-install.types.js";
import type { SkillEntry, SkillInstallSpec } from "./skills.js";
import { resolveSkillToolsRootDir } from "./skills/tools-dir.js";

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

type PinnedDirectory = {
  canonicalPath: string;
  identity: {
    dev: number | bigint;
    ino: number | bigint;
  };
};

async function pinCanonicalDirectory(params: {
  baseDir: string;
  candidatePath: string;
  boundaryLabel: string;
}): Promise<PinnedDirectory> {
  await assertCanonicalPathWithinBase({
    baseDir: params.baseDir,
    candidatePath: params.candidatePath,
    boundaryLabel: params.boundaryLabel,
  });
  const canonicalPath = await fs.promises.realpath(params.candidatePath);
  await assertCanonicalPathWithinBase({
    baseDir: params.baseDir,
    candidatePath: canonicalPath,
    boundaryLabel: params.boundaryLabel,
  });

  const stat = await fs.promises.lstat(canonicalPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Invalid ${params.boundaryLabel}: directory must be real and non-symlinked`);
  }
  return {
    canonicalPath,
    identity: {
      dev: stat.dev,
      ino: stat.ino,
    },
  };
}

async function assertPinnedDirectoryUnchanged(params: {
  baseDir: string;
  pinnedDir: PinnedDirectory;
  boundaryLabel: string;
}): Promise<void> {
  try {
    await assertCanonicalPathWithinBase({
      baseDir: params.baseDir,
      candidatePath: params.pinnedDir.canonicalPath,
      boundaryLabel: params.boundaryLabel,
    });
  } catch {
    throw new Error(`Invalid ${params.boundaryLabel}: directory changed during install`);
  }

  let current: Awaited<ReturnType<typeof fs.promises.lstat>>;
  try {
    current = await fs.promises.lstat(params.pinnedDir.canonicalPath);
  } catch {
    throw new Error(`Invalid ${params.boundaryLabel}: directory changed during install`);
  }
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error(`Invalid ${params.boundaryLabel}: directory changed during install`);
  }
  if (!sameFileIdentity(current, params.pinnedDir.identity)) {
    throw new Error(`Invalid ${params.boundaryLabel}: directory changed during install`);
  }
}

function resolveDownloadTargetDir(params: { safeRoot: string; spec: SkillInstallSpec }): string {
  const raw = params.spec.targetDir?.trim();
  if (!raw) {
    return params.safeRoot;
  }

  // Treat non-absolute paths as relative to the per-skill tools root.
  const resolved =
    raw.startsWith("~") || path.isAbsolute(raw) || isWindowsDrivePath(raw)
      ? resolveUserPath(raw)
      : path.resolve(params.safeRoot, raw);

  if (!isWithinDir(params.safeRoot, resolved)) {
    throw new Error(
      `Refusing to install outside the skill tools directory. targetDir="${raw}" resolves to "${resolved}". Allowed root: "${params.safeRoot}".`,
    );
  }
  return resolved;
}

function resolveArchiveType(spec: SkillInstallSpec, filename: string): string | undefined {
  const explicit = normalizeOptionalLowercaseString(spec.archive);
  if (explicit) {
    return explicit;
  }
  const lower = normalizeOptionalLowercaseString(filename);
  if (!lower) {
    return undefined;
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) {
    return "tar.bz2";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  return undefined;
}

async function downloadFile(params: {
  url: string;
  rootDir: string;
  relativePath: string;
  timeoutMs: number;
  beforeTempWrite?: () => Promise<void>;
  beforeFinalCopy?: () => Promise<void>;
  afterFinalCopy?: () => Promise<void>;
}): Promise<{ bytes: number }> {
  const runBeforeTempWrite = async (): Promise<void> => {
    if (params.beforeTempWrite) {
      await params.beforeTempWrite();
    }
  };

  const destPath = path.resolve(params.rootDir, params.relativePath);
  const stagingDir = path.join(params.rootDir, ".openclaw-download-staging");
  await runBeforeTempWrite();
  await ensureDir(stagingDir);
  await assertCanonicalPathWithinBase({
    baseDir: params.rootDir,
    candidatePath: stagingDir,
    boundaryLabel: "skill tools directory",
  });
  const tempPath = path.join(stagingDir, `${randomUUID()}.tmp`);
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    timeoutMs: Math.max(1_000, params.timeoutMs),
  });
  try {
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status} ${response.statusText})`);
    }
    await runBeforeTempWrite();
    const file = fs.createWriteStream(tempPath);
    const body = response.body as unknown;
    const readable = isNodeReadableStream(body)
      ? body
      : Readable.fromWeb(body as NodeReadableStream);
    await pipeline(readable, file);
    if (params.beforeFinalCopy) {
      await params.beforeFinalCopy();
    }
    await writeFileFromPathWithinRoot({
      rootDir: params.rootDir,
      relativePath: params.relativePath,
      sourcePath: tempPath,
    });
    if (params.afterFinalCopy) {
      await params.afterFinalCopy();
    }
    const stat = await fs.promises.stat(destPath);
    return { bytes: stat.size };
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    await release();
  }
}

export async function installDownloadSpec(params: {
  entry: SkillEntry;
  spec: SkillInstallSpec;
  timeoutMs: number;
}): Promise<SkillInstallResult> {
  const { entry, spec, timeoutMs } = params;
  const safeRoot = resolveSkillToolsRootDir(entry);
  const url = spec.url?.trim();
  if (!url) {
    return {
      ok: false,
      message: "missing download url",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  let filename = "";
  try {
    const parsed = new URL(url);
    filename = path.basename(parsed.pathname);
  } catch {
    filename = path.basename(url);
  }
  if (!filename) {
    filename = "download";
  }

  let canonicalSafeRoot = "";
  let targetDir = "";
  let pinnedTargetDir: PinnedDirectory | undefined;
  try {
    await ensureDir(safeRoot);
    const pinnedSafeRoot = await pinCanonicalDirectory({
      baseDir: safeRoot,
      candidatePath: safeRoot,
      boundaryLabel: "skill tools directory",
    });
    canonicalSafeRoot = pinnedSafeRoot.canonicalPath;

    const requestedTargetDir = resolveDownloadTargetDir({ safeRoot: canonicalSafeRoot, spec });
    await ensureDir(requestedTargetDir);
    pinnedTargetDir = await pinCanonicalDirectory({
      baseDir: canonicalSafeRoot,
      candidatePath: requestedTargetDir,
      boundaryLabel: "skill tools directory",
    });
    targetDir = pinnedTargetDir.canonicalPath;
  } catch (err) {
    const message = formatErrorMessage(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const assertTargetDirStillPinned = async (): Promise<void> => {
    if (!pinnedTargetDir) {
      throw new Error("invalid download target directory");
    }
    await assertPinnedDirectoryUnchanged({
      baseDir: canonicalSafeRoot,
      pinnedDir: pinnedTargetDir,
      boundaryLabel: "skill tools directory",
    });
  };

  const archivePath = path.join(targetDir, filename);
  const archiveRelativePath = path.relative(canonicalSafeRoot, archivePath);
  if (
    !archiveRelativePath ||
    archiveRelativePath === ".." ||
    archiveRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(archiveRelativePath)
  ) {
    return {
      ok: false,
      message: "invalid download archive path",
      stdout: "",
      stderr: "invalid download archive path",
      code: null,
    };
  }
  let downloaded = 0;
  try {
    await assertTargetDirStillPinned();
    const result = await downloadFile({
      url,
      rootDir: canonicalSafeRoot,
      relativePath: archiveRelativePath,
      timeoutMs,
      beforeTempWrite: assertTargetDirStillPinned,
      beforeFinalCopy: assertTargetDirStillPinned,
      afterFinalCopy: assertTargetDirStillPinned,
    });
    downloaded = result.bytes;
  } catch (err) {
    const message = formatErrorMessage(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const archiveType = resolveArchiveType(spec, filename);
  const shouldExtract = spec.extract ?? Boolean(archiveType);
  if (!shouldExtract) {
    return {
      ok: true,
      message: `Downloaded to ${archivePath}`,
      stdout: `downloaded=${downloaded}`,
      stderr: "",
      code: 0,
    };
  }

  if (!archiveType) {
    return {
      ok: false,
      message: "extract requested but archive type could not be detected",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  try {
    await assertTargetDirStillPinned();
  } catch (err) {
    const message = formatErrorMessage(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const extractResult = await extractArchive({
    archivePath,
    archiveType,
    targetDir,
    stripComponents: spec.stripComponents,
    timeoutMs,
    validateTargetDir: assertTargetDirStillPinned,
  });
  const success = extractResult.code === 0;
  return {
    ok: success,
    message: success
      ? `Downloaded and extracted to ${targetDir}`
      : formatInstallFailureMessage(extractResult),
    stdout: extractResult.stdout.trim(),
    stderr: extractResult.stderr.trim(),
    code: extractResult.code,
  };
}
