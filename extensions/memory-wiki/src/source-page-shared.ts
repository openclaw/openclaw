// Memory Wiki plugin module implements source page shared behavior.
import fs from "node:fs/promises";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
<<<<<<< HEAD
import { preserveHumanNotesBlock } from "./markdown.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import {
  setImportedSourceEntry,
  shouldSkipImportedSourceWrite,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";
<<<<<<< HEAD
import { writeGuardedVaultPage } from "./vault-page-write.js";

type ImportedSourceState = Parameters<typeof shouldSkipImportedSourceWrite>[0]["state"];

=======

type ImportedSourceState = Parameters<typeof shouldSkipImportedSourceWrite>[0]["state"];

type FileStatLike = {
  isFile?: unknown;
  nlink?: unknown;
};

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

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export async function writeImportedSourcePage(params: {
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
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const vault = await fsRoot(params.vaultRoot);
  const pageStat = await vault.stat(params.pagePath).catch((error: unknown) => {
    if (
      error instanceof FsSafeError &&
      (error.code === "not-found" || error.code === "path-alias")
    ) {
      return null;
    }
    throw error;
  });
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
  const existing = pageStat ? await vault.readText(params.pagePath).catch(() => "") : "";
<<<<<<< HEAD
  const nextRendered = existing ? preserveHumanNotesBlock(rendered, existing) : rendered;
  if (existing !== nextRendered) {
    await writeGuardedVaultPage({
      vault,
      pagePath: params.pagePath,
      content: nextRendered,
      pageStat,
      pageLabel: "imported source page",
    });
=======
  if (existing !== rendered) {
    try {
      if (isRegularFileStat(pageStat) && pageStat.nlink > 1) {
        await vault.remove(params.pagePath);
      }
      await vault.write(params.pagePath, rendered);
    } catch (error) {
      if (error instanceof FsSafeError) {
        if (error.code !== "symlink" && error.code !== "path-alias") {
          throw new Error(
            `Refusing to write imported source page (${error.code}): ${params.pagePath}: ${error.message}`,
            { cause: error },
          );
        }
        throw new Error(
          `Refusing to write imported source page through symlink: ${params.pagePath}`,
          { cause: error },
        );
      }
      throw error;
    }
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
  return { pagePath: params.pagePath, changed: existing !== nextRendered, created };
=======
  return { pagePath: params.pagePath, changed: existing !== rendered, created };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}
