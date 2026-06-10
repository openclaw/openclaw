// Memory Wiki plugin module implements source page shared behavior.
import fs from "node:fs/promises";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  setImportedSourceEntry,
  shouldSkipImportedSourceWrite,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";

type ImportedSourceState = Parameters<typeof shouldSkipImportedSourceWrite>[0]["state"];
type ImportedSourceVault = Awaited<ReturnType<typeof fsRoot>>;
type WriteImportedSourcePageResult = { pagePath: string; changed: boolean; created: boolean };
type WriteImportedSourcePageParams = {
  vaultRoot: string;
  syncKey: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
  pagePath: string;
  group: MemoryWikiImportedSourceGroup;
  state: ImportedSourceState;
  buildRendered: (raw: string, updatedAt: string) => string;
};

type FileStatLike = {
  isFile?: unknown;
  nlink?: unknown;
};

const IMPORTED_SOURCE_PAGE_PATH_MISMATCH_RETRIES = 2;

class ImportedSourcePagePathMismatchAfterWriteError extends Error {
  readonly pathMismatch: FsSafeError;
  readonly result: WriteImportedSourcePageResult;

  constructor(pathMismatch: FsSafeError, result: WriteImportedSourcePageResult) {
    super(pathMismatch.message, { cause: pathMismatch });
    this.name = "ImportedSourcePagePathMismatchAfterWriteError";
    this.pathMismatch = pathMismatch;
    this.result = result;
  }
}

function isRegularFileStat(value: unknown): value is FileStatLike & { nlink: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const stat = value as FileStatLike;
  const isFile =
    typeof stat.isFile === "function"
      ? (stat.isFile as () => boolean).call(stat)
      : stat.isFile === true;
  return isFile && typeof stat.nlink === "number";
}

function isPathMismatchError(error: unknown): error is FsSafeError {
  return error instanceof FsSafeError && error.code === "path-mismatch";
}

function wrapImportedSourcePageFsSafeError(error: FsSafeError, pagePath: string): Error {
  if (error.code === "symlink" || error.code === "path-alias") {
    return new Error(`Refusing to write imported source page through symlink: ${pagePath}`, {
      cause: error,
    });
  }
  return new Error(
    `Refusing to write imported source page (${error.code}): ${pagePath}: ${error.message}`,
    {
      cause: error,
    },
  );
}

async function statImportedSourcePage(vault: ImportedSourceVault, pagePath: string) {
  return await vault.stat(pagePath).catch((error: unknown) => {
    if (
      error instanceof FsSafeError &&
      (error.code === "not-found" || error.code === "path-alias")
    ) {
      return null;
    }
    throw error;
  });
}

async function writeImportedSourcePageOnce(
  vault: ImportedSourceVault,
  params: WriteImportedSourcePageParams,
): Promise<WriteImportedSourcePageResult> {
  const pageStat = await statImportedSourcePage(vault, params.pagePath);
  const created = !pageStat;
  const updatedAt = timestampMsToIsoString(params.sourceUpdatedAtMs) ?? new Date().toISOString();
  const shouldSkip = await shouldSkipImportedSourceWrite({
    vaultRoot: params.vaultRoot,
    syncKey: params.syncKey,
    expectedPagePath: params.pagePath,
    expectedSourcePath: params.sourcePath,
    sourceUpdatedAtMs: params.sourceUpdatedAtMs,
    sourceSize: params.sourceSize,
    renderFingerprint: params.renderFingerprint,
    state: params.state,
  });
  if (shouldSkip) {
    return { pagePath: params.pagePath, changed: false, created };
  }

  const raw = await fs.readFile(params.sourcePath, "utf8");
  const rendered = params.buildRendered(raw, updatedAt);
  const existing = pageStat
    ? await vault.readText(params.pagePath).catch((error: unknown) => {
        if (isPathMismatchError(error)) {
          throw error;
        }
        return "";
      })
    : "";
  const result = { pagePath: params.pagePath, changed: existing !== rendered, created };
  if (result.changed) {
    if (isRegularFileStat(pageStat) && pageStat.nlink > 1) {
      await vault.remove(params.pagePath);
    }
    await vault.write(params.pagePath, rendered).catch((error: unknown) => {
      if (isPathMismatchError(error)) {
        throw new ImportedSourcePagePathMismatchAfterWriteError(error, result);
      }
      throw error;
    });
  }

  setImportedSourceEntry({
    syncKey: params.syncKey,
    state: params.state,
    entry: {
      group: params.group,
      pagePath: params.pagePath,
      sourcePath: params.sourcePath,
      sourceUpdatedAtMs: params.sourceUpdatedAtMs,
      sourceSize: params.sourceSize,
      renderFingerprint: params.renderFingerprint,
    },
  });
  return result;
}

export async function writeImportedSourcePage(
  params: WriteImportedSourcePageParams,
): Promise<WriteImportedSourcePageResult> {
  const vault = await fsRoot(params.vaultRoot);
  let recoveredWriteResult: WriteImportedSourcePageResult | undefined;
  for (let attempt = 0; attempt <= IMPORTED_SOURCE_PAGE_PATH_MISMATCH_RETRIES; attempt += 1) {
    try {
      const result = await writeImportedSourcePageOnce(vault, params);
      return recoveredWriteResult
        ? {
            ...result,
            changed: result.changed || recoveredWriteResult.changed,
            created: recoveredWriteResult.created,
          }
        : result;
    } catch (error) {
      if (error instanceof ImportedSourcePagePathMismatchAfterWriteError) {
        recoveredWriteResult ??= error.result;
        if (attempt < IMPORTED_SOURCE_PAGE_PATH_MISMATCH_RETRIES) {
          continue;
        }
        throw wrapImportedSourcePageFsSafeError(error.pathMismatch, params.pagePath);
      }
      if (isPathMismatchError(error) && attempt < IMPORTED_SOURCE_PAGE_PATH_MISMATCH_RETRIES) {
        continue;
      }
      if (error instanceof FsSafeError) {
        throw wrapImportedSourcePageFsSafeError(error, params.pagePath);
      }
      throw error;
    }
  }
  throw new Error("Imported source page write retry loop exited unexpectedly");
}
