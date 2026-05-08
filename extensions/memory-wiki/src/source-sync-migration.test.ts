import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/migration";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { createMemoryWikiSourceSyncMigrationProvider } from "./source-sync-migration.js";

const tempDirs: string[] = [];

async function createVaultRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-migration-"));
  tempDirs.push(root);
  return root;
}

function createConfig(vaultRoot: string): ResolvedMemoryWikiConfig {
  return {
    vaultMode: "isolated",
    vault: { path: vaultRoot, renderMode: "native" },
    obsidian: { enabled: false, useOfficialCli: false, openAfterWrites: false },
    bridge: {
      enabled: false,
      readMemoryArtifacts: false,
      indexDreamReports: false,
      indexDailyNotes: false,
      indexMemoryRoot: false,
      followMemoryEvents: false,
    },
    unsafeLocal: { allowPrivateMemoryCoreAccess: false, paths: [] },
    ingest: { autoCompile: false, maxConcurrentJobs: 1, allowUrlIngest: false },
    search: { backend: "shared", corpus: "wiki" },
    context: { includeCompiledDigestPrompt: false },
    render: { preserveHumanBlocks: true, createBacklinks: true, createDashboards: true },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("memory wiki source sync migration", () => {
  it("removes retired vault metadata files during doctor migration", async () => {
    const vaultRoot = await createVaultRoot();
    const metadataDir = path.join(vaultRoot, ".openclaw-wiki");
    const locksDir = path.join(metadataDir, "locks");
    await fs.mkdir(locksDir, { recursive: true });
    await fs.writeFile(path.join(metadataDir, "state.json"), '{"version":1}\n', "utf8");
    await fs.writeFile(path.join(locksDir, "stale.lock"), "stale", "utf8");

    const provider = createMemoryWikiSourceSyncMigrationProvider(createConfig(vaultRoot));
    await expect(provider.detect()).resolves.toMatchObject({
      found: true,
      confidence: "high",
    });
    const plan = await provider.plan({} as MigrationProviderContext);

    expect(plan.items.map((item) => item.id)).toContain("memory-wiki-vault-metadata-json");

    const result = await provider.apply({} as MigrationProviderContext, plan);
    const item = result.items.find((item) => item.id === "memory-wiki-vault-metadata-json");

    expect(item).toMatchObject({
      status: "migrated",
      details: { removedStateFile: true, removedLocksDir: true },
    });
    await expect(fs.stat(path.join(metadataDir, "state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(locksDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
