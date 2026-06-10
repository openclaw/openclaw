// Memory Wiki plugin module implements source page shared behavior.
import fs from "node:fs/promises";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { preserveHumanNotesBlock } from "./markdown.js";
import {
  setImportedSourceEntry,
  shouldSkipImportedSourceWrite,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";
import { writeGuardedVaultPage } from "./vault-page-write.js";

type ImportedSourceState = Parameters<typeof shouldSkipImportedSourceWrite>[0]["state"];
type ImportedSourceVault = Awaited<ReturnType<typeof fsRoot>>;
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

const IMPORTED_SOURCE_PAGE_PATH_MISMATCH_RETRIES = 2;

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
): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
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
  const nextRendered = existing ? preserveHumanNotesBlock(rendered, existing) : rendered;
  if (existing !== nextRendered) {
    await writeGuardedVaultPage({
      vault,
      pagePath: params.pagePath,
      content: nextRendered,
      pageStat,
      pageLabel: "imported source page",
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
  return { pagePath: params.pagePath, changed: existing !== nextRendered, created };
}

export async function writeImportedSourcePage(
  params: WriteImportedSourcePageParams,
): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const vault = await fsRoot(params.vaultRoot);
  for (let attempt = 0; attempt <= IMPORTED_SOURCE_PAGE_PATH_MISMATCH_RETRIES; attempt += 1) {
    try {
      return await writeImportedSourcePageOnce(vault, params);
    } catch (error) {
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
