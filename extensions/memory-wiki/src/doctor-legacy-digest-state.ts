import fs from "node:fs/promises";
import path from "node:path";
import { type MemoryWikiDigestKind, writeMemoryWikiDigestForMigration } from "./digest-state.js";

export const MEMORY_WIKI_AGENT_DIGEST_LEGACY_PATH = ".openclaw-wiki/cache/agent-digest.json";
export const MEMORY_WIKI_CLAIMS_DIGEST_LEGACY_PATH = ".openclaw-wiki/cache/claims.jsonl";

export function resolveMemoryWikiLegacyDigestPath(
  vaultRoot: string,
  kind: MemoryWikiDigestKind,
): string {
  return path.join(
    vaultRoot,
    kind === "agent-digest"
      ? MEMORY_WIKI_AGENT_DIGEST_LEGACY_PATH
      : MEMORY_WIKI_CLAIMS_DIGEST_LEGACY_PATH,
  );
}

async function importLegacyDigest(params: {
  vaultRoot: string;
  kind: MemoryWikiDigestKind;
}): Promise<{ imported: boolean; sourcePath: string }> {
  const sourcePath = resolveMemoryWikiLegacyDigestPath(params.vaultRoot, params.kind);
  const content = await fs.readFile(sourcePath, "utf8");
  await writeMemoryWikiDigestForMigration({
    vaultRoot: params.vaultRoot,
    kind: params.kind,
    content,
  });
  await fs.rm(sourcePath, { force: true });
  return { imported: true, sourcePath };
}

export async function legacyMemoryWikiDigestFilesExist(vaultRoot: string): Promise<boolean> {
  const results = await Promise.all(
    (["agent-digest", "claims-digest"] as const).map((kind) =>
      fs
        .stat(resolveMemoryWikiLegacyDigestPath(vaultRoot, kind))
        .then((stat) => stat.isFile())
        .catch(() => false),
    ),
  );
  return results.some(Boolean);
}

export async function importMemoryWikiLegacyDigestFiles(params: {
  vaultRoot: string;
}): Promise<{ imported: number; warnings: string[]; sourcePaths: string[] }> {
  const warnings: string[] = [];
  const sourcePaths: string[] = [];
  let imported = 0;
  for (const kind of ["agent-digest", "claims-digest"] as const) {
    try {
      const result = await importLegacyDigest({ vaultRoot: params.vaultRoot, kind });
      imported += result.imported ? 1 : 0;
      sourcePaths.push(result.sourcePath);
    } catch (error) {
      const sourcePath = resolveMemoryWikiLegacyDigestPath(params.vaultRoot, kind);
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      warnings.push(`Failed importing Memory Wiki ${kind}: ${String(error)}`);
      sourcePaths.push(sourcePath);
    }
  }
  const cacheDir = path.join(params.vaultRoot, ".openclaw-wiki", "cache");
  await fs.rmdir(cacheDir).catch(() => undefined);
  return { imported, warnings, sourcePaths };
}
