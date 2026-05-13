import fs from "node:fs/promises";
import path from "node:path";
import {
  type MemoryWikiImportedSourceGroup,
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";

type MemoryWikiImportedSourceStateEntry = {
  group: MemoryWikiImportedSourceGroup;
  pagePath: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
};

export function resolveMemoryWikiLegacySourceSyncStatePath(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "source-sync.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseLegacySourceSyncEntry(raw: unknown): MemoryWikiImportedSourceStateEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.group !== "bridge" && raw.group !== "unsafe-local") {
    return null;
  }
  if (
    typeof raw.pagePath !== "string" ||
    typeof raw.sourcePath !== "string" ||
    typeof raw.sourceUpdatedAtMs !== "number" ||
    typeof raw.sourceSize !== "number" ||
    typeof raw.renderFingerprint !== "string"
  ) {
    return null;
  }
  return {
    group: raw.group,
    pagePath: raw.pagePath,
    sourcePath: raw.sourcePath,
    sourceUpdatedAtMs: raw.sourceUpdatedAtMs,
    sourceSize: raw.sourceSize,
    renderFingerprint: raw.renderFingerprint,
  };
}

export async function importMemoryWikiLegacySourceSyncState(params: {
  vaultRoot: string;
}): Promise<{ imported: number; warnings: string[]; sourcePath: string }> {
  const sourcePath = resolveMemoryWikiLegacySourceSyncStatePath(params.vaultRoot);
  const rawText = await fs.readFile(sourcePath, "utf8");
  const raw = JSON.parse(rawText) as unknown;
  const warnings: string[] = [];
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.entries)) {
    return {
      imported: 0,
      warnings: [`Skipped invalid Memory Wiki source sync file: ${sourcePath}`],
      sourcePath,
    };
  }
  const state = await readMemoryWikiSourceSyncState(params.vaultRoot);
  let imported = 0;
  for (const [syncKey, entry] of Object.entries(raw.entries)) {
    const parsed = parseLegacySourceSyncEntry(entry);
    if (!parsed) {
      warnings.push(`Skipped invalid Memory Wiki source sync entry "${syncKey}".`);
      continue;
    }
    state.entries[syncKey] = parsed;
    imported++;
  }
  await writeMemoryWikiSourceSyncState(params.vaultRoot, state);
  await fs.rm(sourcePath, { force: true });
  return { imported, warnings, sourcePath };
}
