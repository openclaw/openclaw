import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  extractArchive,
  type ArchiveExtractLimits,
} from "openclaw/plugin-sdk/archive";
import type { LlamaServerArchive, LlamaServerAsset } from "./llama-server-assets.js";

const MEBIBYTE = 1024 * 1024;
const LLAMA_ARCHIVE_LIMITS = {
  maxArchiveBytes: 256 * MEBIBYTE,
  maxEntries: 1_000,
  maxExtractedBytes: 512 * MEBIBYTE,
  maxEntryBytes: 256 * MEBIBYTE,
  maxMetaEntryBytes: MEBIBYTE,
} satisfies ArchiveExtractLimits;
const MAX_ALIAS_BYTES = 512 * MEBIBYTE;

async function assertRegularFile(filePath: string, label: string): Promise<Stats> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat?.isFile() || stat.nlink > 1) {
    throw new Error(`llama-server archive does not contain regular ${label}`);
  }
  return stat;
}

async function materializeAssetAliases(params: {
  rootDir: string;
  asset: LlamaServerArchive;
  requiredFiles: readonly string[];
}): Promise<void> {
  // Paths come from the private pinned asset manifest, not archive entries.
  for (const file of params.requiredFiles) {
    await assertRegularFile(path.join(params.rootDir, file), `file ${file}`);
  }
  let copiedBytes = 0;
  for (const [source, aliases] of params.asset.regularFileAliases) {
    const sourcePath = path.join(params.rootDir, source);
    const sourceStat = await assertRegularFile(sourcePath, `alias source ${source}`);
    for (const alias of aliases) {
      copiedBytes += sourceStat.size;
      if (copiedBytes > MAX_ALIAS_BYTES) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT);
      }
      const aliasPath = path.join(params.rootDir, alias);
      await fs.copyFile(sourcePath, aliasPath, fsConstants.COPYFILE_EXCL);
      await fs.chmod(aliasPath, sourceStat.mode & 0o777);
    }
  }
}

async function extractVerifiedArchive(params: {
  archivePath: string;
  destDir: string;
  asset: LlamaServerArchive;
  requiredFiles: readonly string[];
}): Promise<string> {
  const isTar = params.asset.archive === "tar.gz";
  const limits = { ...LLAMA_ARCHIVE_LIMITS, ...params.asset.limits };
  const aliasCount = params.asset.regularFileAliases.reduce(
    (count, [, aliases]) => count + aliases.length,
    0,
  );
  if (aliasCount > limits.maxEntries) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT);
  }
  await extractArchive({
    archivePath: params.archivePath,
    destDir: params.destDir,
    kind: isTar ? "tar" : "zip",
    // The installer owns destination cleanup, so keep extraction joined instead of racing
    // fs-safe's internal transaction against a caller-side timeout.
    timeoutMs: 0,
    limits: {
      ...limits,
      maxEntries: limits.maxEntries - aliasCount,
    },
    tarGzip: isTar,
    entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
    onFiltered: "skip-entry",
  });
  const rootDir = path.join(params.destDir, params.asset.archiveRoot);
  await materializeAssetAliases({
    rootDir,
    asset: params.asset,
    requiredFiles: params.requiredFiles,
  });
  return rootDir;
}

/** Extracts one verified asset and returns its unpublished executable path. */
export async function extractLlamaServerArchive(params: {
  archivePath: string;
  destDir: string;
  asset: LlamaServerAsset;
}): Promise<string> {
  const rootDir = await extractVerifiedArchive({
    ...params,
    requiredFiles: [params.asset.executable],
  });
  return path.join(rootDir, params.asset.executable);
}

export async function extractLlamaServerDependencyArchive(params: {
  archivePath: string;
  destDir: string;
  asset: LlamaServerArchive & { files: readonly string[] };
}): Promise<string> {
  return await extractVerifiedArchive({ ...params, requiredFiles: params.asset.files });
}
