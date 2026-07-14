// Memory Wiki tests cover doctor migration of legacy source sync state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  createMemoryWikiImportRunStateStore,
  readMemoryWikiImportRunRecord,
} from "./src/import-runs-state.js";
import {
  createMemoryWikiSourceSyncStateStore,
  readMemoryWikiSourceSyncState,
  resolveMemoryWikiSourceSyncStatePath,
} from "./src/source-sync-state.js";

function requireStateMigration(index: number) {
  return expectDefined(stateMigrations[index], `Memory Wiki state migration ${index}`);
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-doctor-"));
  tempDirs.push(dir);
  return dir;
}

function resolveLegacyImportRunRecordPath(vaultRoot: string, runId: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "import-runs", `${runId}.json`);
}

function migrationParams(params: { stateDir: string; vaultRoot: string; agentIds?: string[] }) {
  const env = { ...process.env, HOME: params.stateDir, OPENCLAW_STATE_DIR: params.stateDir };
  return {
    config: {
      ...(params.agentIds ? { agents: { list: params.agentIds.map((id) => ({ id })) } } : {}),
      plugins: {
        entries: {
          "memory-wiki": {
            config: {
              vault: {
                path: params.vaultRoot,
                ...(params.agentIds ? { scope: "agent" as const } : {}),
              },
            },
          },
        },
      },
    },
    env,
    stateDir: params.stateDir,
    oauthDir: path.join(params.stateDir, "credentials"),
    context: {
      openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
    },
  };
}

describe("memory-wiki doctor source sync migration", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("detects and migrates legacy source-sync.json into plugin state", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          alpha: {
            group: "bridge",
            pagePath: "sources/alpha.md",
            sourcePath: "/tmp/alpha.md",
            sourceUpdatedAtMs: 100,
            sourceSize: 200,
            renderFingerprint: "alpha",
          },
        },
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration(0);

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("Memory Wiki source sync:")],
    });

    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki source sync -> plugin state (1 imported, 0 existing)",
        expect.stringContaining("Archived Memory Wiki source-sync legacy source ->"),
      ],
      warnings: [],
    });
    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        alpha: {
          group: "bridge",
          pagePath: "sources/alpha.md",
          sourcePath: "/tmp/alpha.md",
          sourceUpdatedAtMs: 100,
          sourceSize: 200,
          renderFingerprint: "alpha",
        },
      },
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${legacyPath}.migrated`)).resolves.toBeDefined();
  });

  it("detects and migrates legacy import-run records into plugin state", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveLegacyImportRunRecordPath(vaultRoot, "chatgpt-alpha");
    const snapshotPath = path.join(
      vaultRoot,
      ".openclaw-wiki",
      "import-runs",
      "chatgpt-alpha",
      "snapshots",
      "alpha.md",
    );
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, "previous page\n", "utf8");
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        runId: "chatgpt-alpha",
        importType: "chatgpt",
        exportPath: "/tmp/chatgpt",
        sourcePath: "/tmp/chatgpt/conversations.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 2,
        createdCount: 1,
        updatedCount: 1,
        skippedCount: 0,
        createdPaths: ["sources/new.md"],
        updatedPaths: [{ path: "sources/existing.md", snapshotPath: "snapshots/alpha.md" }],
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = stateMigrations.find(
      (entry) => entry.id === "memory-wiki-import-runs-json-to-plugin-state",
    );
    if (!migration) {
      throw new Error("Expected import-run migration");
    }

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("Memory Wiki import runs:")],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki import runs -> plugin state (1 imported, 0 existing)",
        expect.stringContaining("Archived Memory Wiki import-run legacy source ->"),
      ],
      warnings: [],
    });
    const store = createMemoryWikiImportRunStateStore(params.context.openPluginStateKeyedStore);
    await expect(readMemoryWikiImportRunRecord(vaultRoot, "chatgpt-alpha", store)).resolves.toEqual(
      {
        version: 1,
        runId: "chatgpt-alpha",
        importType: "chatgpt",
        exportPath: "/tmp/chatgpt",
        sourcePath: "/tmp/chatgpt/conversations.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 2,
        createdCount: 1,
        updatedCount: 1,
        skippedCount: 0,
        createdPaths: ["sources/new.md"],
        updatedPaths: [{ path: "sources/existing.md", snapshotPath: "snapshots/alpha.md" }],
      },
    );
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${legacyPath}.migrated`)).resolves.toBeDefined();
    await expect(fs.readFile(snapshotPath, "utf8")).resolves.toBe("previous page\n");
  });

  it("skips malformed legacy import-run files, leaving them in place with a warning", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const validPath = resolveLegacyImportRunRecordPath(vaultRoot, "chatgpt-valid");
    const malformedPath = resolveLegacyImportRunRecordPath(vaultRoot, "chatgpt-broken");
    await fs.mkdir(path.dirname(validPath), { recursive: true });
    await fs.writeFile(
      validPath,
      `${JSON.stringify({
        version: 1,
        runId: "chatgpt-valid",
        importType: "chatgpt",
        exportPath: "/tmp/a",
        sourcePath: "/tmp/a/conv.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 1,
        createdCount: 1,
        updatedCount: 0,
        skippedCount: 0,
        createdPaths: ["sources/a.md"],
        updatedPaths: [],
      })}\n`,
    );
    // Partial write / editor save with a syntax error -> not valid JSON.
    await fs.writeFile(malformedPath, "{ broken json , ");

    const params = migrationParams({ stateDir, vaultRoot });
    const migration = stateMigrations.find(
      (entry) => entry.id === "memory-wiki-import-runs-json-to-plugin-state",
    );
    if (!migration) {
      throw new Error("Expected import-run migration");
    }

    // Detection still reports the valid record; malformed ones do not block detection.
    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("Memory Wiki import runs:")],
    });
    // Migration succeeds; the malformed file is left in place with a warning.
    const result = await migration.migrateLegacyState(params);
    expect(result.warnings).toEqual([expect.stringContaining("legacy import-run file")]);
    // Valid file -> archived (renamed).
    await expect(fs.stat(validPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${validPath}.migrated`)).resolves.toBeDefined();
    // Malformed file -> left in place (not archived, not renamed).
    await expect(fs.stat(malformedPath)).resolves.toBeDefined();
    await expect(fs.stat(`${malformedPath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips schema-invalid legacy import-run files, leaving them in place with a warning", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const validPath = resolveLegacyImportRunRecordPath(vaultRoot, "chatgpt-valid");
    const badSchemaPath = resolveLegacyImportRunRecordPath(vaultRoot, "chatgpt-bad");
    await fs.mkdir(path.dirname(validPath), { recursive: true });
    await fs.writeFile(
      validPath,
      JSON.stringify({
        version: 1,
        runId: "chatgpt-valid",
        importType: "chatgpt",
        exportPath: "/tmp/a",
        sourcePath: "/tmp/a/conv.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 1,
        createdCount: 1,
        updatedCount: 0,
        skippedCount: 0,
        createdPaths: ["sources/a.md"],
        updatedPaths: [],
      }) + "\n",
    );
    // Syntactically valid JSON, but version 99 — schema-invalid (reader skips it).
    await fs.writeFile(
      badSchemaPath,
      JSON.stringify({
        version: 99,
        runId: "chatgpt-bad",
        importType: "chatgpt",
        exportPath: "/tmp/b",
        sourcePath: "/tmp/b/conv.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 1,
        createdCount: 1,
        updatedCount: 0,
        skippedCount: 0,
        createdPaths: ["sources/b.md"],
        updatedPaths: [],
      }) + "\n",
    );

    const params = migrationParams({ stateDir, vaultRoot });
    const migration = stateMigrations.find(
      (entry) => entry.id === "memory-wiki-import-runs-json-to-plugin-state",
    );
    if (!migration) {
      throw new Error("Expected import-run migration");
    }

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("Memory Wiki import runs:")],
    });
    const result = await migration.migrateLegacyState(params);
    expect(result.warnings).toEqual([expect.stringContaining("legacy import-run file")]);
    // Valid file -> archived.
    await expect(fs.stat(validPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${validPath}.migrated`)).resolves.toBeDefined();
    // Schema-invalid file -> left in place.
    await expect(fs.stat(badSchemaPath)).resolves.toBeDefined();
    await expect(fs.stat(`${badSchemaPath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("diagnoses a malformed-only vault via archive warnings", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const malformedPath = resolveLegacyImportRunRecordPath(vaultRoot, "broken");
    await fs.mkdir(path.dirname(malformedPath), { recursive: true });
    await fs.writeFile(malformedPath, "{ not json , ");

    const params = migrationParams({ stateDir, vaultRoot });
    const migration = stateMigrations.find(
      (entry) => entry.id === "memory-wiki-import-runs-json-to-plugin-state",
    );
    if (!migration) {
      throw new Error("Expected import-run migration");
    }

    // No valid records, but a malformed file is still present: detect must plan
    // the migration so the doctor runs migrateLegacyState, which emits an archive
    // diagnostic instead of silently leaving the bad file behind.
    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("malformed/schema-invalid file(s) to diagnose")],
    });
    // migrate runs and warns about the malformed file; it stays in place.
    const result = await migration.migrateLegacyState(params);
    expect(result?.warnings).toEqual([
      expect.stringContaining(`Skipped legacy import-run file ${malformedPath}`),
    ]);
    await expect(fs.stat(malformedPath)).resolves.toBeDefined();
  });

  it("skips a schema-invalid-only vault without crashing", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const badSchemaPath = resolveLegacyImportRunRecordPath(vaultRoot, "bad");
    await fs.mkdir(path.dirname(badSchemaPath), { recursive: true });
    await fs.writeFile(
      badSchemaPath,
      JSON.stringify({
        version: 99,
        runId: "bad",
        importType: "chatgpt",
        exportPath: "/tmp/b",
        sourcePath: "/tmp/b/conv.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 1,
        createdCount: 1,
        updatedCount: 0,
        skippedCount: 0,
        createdPaths: [],
        updatedPaths: [],
      }) + "\n",
    );

    const params = migrationParams({ stateDir, vaultRoot });
    const migration = stateMigrations.find(
      (entry) => entry.id === "memory-wiki-import-runs-json-to-plugin-state",
    );
    if (!migration) {
      throw new Error("Expected import-run migration");
    }

    // No valid records, but a schema-invalid file is still present: detect must
    // plan the migration so migrateLegacyState runs and emits an archive warning.
    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("malformed/schema-invalid file(s) to diagnose")],
    });
    const schemaResult = await migration.migrateLegacyState(params);
    expect(schemaResult?.warnings).toEqual([
      expect.stringContaining(`Skipped legacy import-run file ${badSchemaPath}`),
    ]);
    await expect(fs.stat(badSchemaPath)).resolves.toBeDefined();
  });

  it("merges legacy entries with existing plugin state before archiving", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          stale: {
            group: "bridge",
            pagePath: "sources/stale.md",
            sourcePath: "/tmp/stale.md",
            sourceUpdatedAtMs: 10,
            sourceSize: 20,
            renderFingerprint: "stale",
          },
          current: {
            group: "bridge",
            pagePath: "sources/current-old.md",
            sourcePath: "/tmp/current-old.md",
            sourceUpdatedAtMs: 30,
            sourceSize: 40,
            renderFingerprint: "old",
          },
        },
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    await store.write(vaultRoot, {
      version: 1,
      entries: {
        current: {
          group: "bridge",
          pagePath: "sources/current.md",
          sourcePath: "/tmp/current.md",
          sourceUpdatedAtMs: 50,
          sourceSize: 60,
          renderFingerprint: "current",
        },
      },
    });

    await expect(requireStateMigration(0).migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki source sync -> plugin state (1 imported, 1 existing)",
        expect.stringContaining("Archived Memory Wiki source-sync legacy source ->"),
      ],
      warnings: [],
    });
    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        stale: {
          group: "bridge",
          pagePath: "sources/stale.md",
          sourcePath: "/tmp/stale.md",
          sourceUpdatedAtMs: 10,
          sourceSize: 20,
          renderFingerprint: "stale",
        },
        current: {
          group: "bridge",
          pagePath: "sources/current.md",
          sourcePath: "/tmp/current.md",
          sourceUpdatedAtMs: 50,
          sourceSize: 60,
          renderFingerprint: "current",
        },
      },
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy state from every configured agent vault", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vaults");
    const agentIds = ["support", "marketing"];
    for (const agentId of agentIds) {
      const legacyPath = resolveMemoryWikiSourceSyncStatePath(path.join(vaultRoot, agentId));
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({
          version: 1,
          entries: {
            [agentId]: {
              group: "bridge",
              pagePath: `sources/${agentId}.md`,
              sourcePath: `/tmp/${agentId}.md`,
              sourceUpdatedAtMs: 100,
              sourceSize: 200,
              renderFingerprint: agentId,
            },
          },
        })}\n`,
      );
    }

    const params = migrationParams({ stateDir, vaultRoot, agentIds });
    await expect(requireStateMigration(0).detectLegacyState(params)).resolves.toEqual({
      preview: [
        expect.stringContaining(path.join(vaultRoot, "support")),
        expect.stringContaining(path.join(vaultRoot, "marketing")),
      ],
    });
    await expect(requireStateMigration(0).migrateLegacyState(params)).resolves.toMatchObject({
      warnings: [],
    });

    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    for (const agentId of agentIds) {
      await expect(
        readMemoryWikiSourceSyncState(path.join(vaultRoot, agentId), store),
      ).resolves.toMatchObject({ entries: { [agentId]: { renderFingerprint: agentId } } });
    }
  });
});
