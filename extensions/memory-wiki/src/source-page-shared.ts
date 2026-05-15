import fs from "node:fs/promises";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  setImportedSourceEntry,
  shouldSkipImportedSourceWrite,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";

type ImportedSourceState = Parameters<typeof shouldSkipImportedSourceWrite>[0]["state"];

function hasGroupProvenance(text: string, group: MemoryWikiImportedSourceGroup): boolean {
  if (group === "bridge") {
    return /^bridgeRelativePath:\s*\S+/m.test(text) && /^bridgeWorkspaceDir:\s*\S+/m.test(text);
  }
  if (group === "unsafe-local") {
    return (
      /^unsafeLocalConfiguredPath:\s*\S+/m.test(text) &&
      /^unsafeLocalRelativePath:\s*\S+/m.test(text)
    );
  }
  return false;
}

function importedSourcePageLooksComplete(
  text: string,
  sourcePath: string,
  group: MemoryWikiImportedSourceGroup,
): boolean {
  return (
    text.startsWith("---\n") &&
    /^pageType:\s*source\s*$/m.test(text) &&
    /^id:\s*\S+/m.test(text) &&
    /^updatedAt:\s*\S+/m.test(text) &&
    text.includes(`sourcePath: ${sourcePath}`) &&
    /^## Content\s*$/m.test(text) &&
    hasGroupProvenance(text, group)
  );
}

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
  const updatedAt = new Date(params.sourceUpdatedAtMs).toISOString();
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
    const existing = pageStat ? await vault.readText(params.pagePath).catch(() => "") : "";
    if (importedSourcePageLooksComplete(existing, params.sourcePath, params.group)) {
      return { pagePath: params.pagePath, changed: false, created };
    }
  }

  const raw = await fs.readFile(params.sourcePath, "utf8");
  const rendered = params.buildRendered(raw, updatedAt);
  const existing = pageStat ? await vault.readText(params.pagePath).catch(() => "") : "";
  if (existing !== rendered) {
    try {
      if (pageStat && pageStat.nlink > 1) {
        await vault.remove(params.pagePath);
      }
      await vault.write(params.pagePath, rendered);
    } catch (error) {
      if (error instanceof FsSafeError) {
        throw new Error(
          `Refusing to write imported source page through symlink: ${params.pagePath}`,
          { cause: error },
        );
      }
      throw error;
    }
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
  return { pagePath: params.pagePath, changed: existing !== rendered, created };
}
