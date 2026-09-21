import assert from "node:assert/strict";
// Diffs helper module supports test helpers behavior.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  OpenBlobStoreOptions,
  PluginBlobStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobStoreForTests,
  createPluginBlobKernelStore,
  resetPluginBlobStoreForTests,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawStateDatabase,
  type OpenClawStateKyselyDatabaseForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "../api.js";
import { DiffArtifactStore } from "./store.js";
import type { DiffArtifactBlobMetadata } from "./types.js";

const execFileAsync = promisify(execFile);

export async function expireDiffArtifactForTest(
  rootDir: string,
  id: string,
  expectedTtlMs: number,
): Promise<void> {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(path.dirname(rootDir), "state") },
  });
  const database = getNodeSqliteKysely<OpenClawStateKyselyDatabaseForTests>(db);
  const entry = executeSqliteQuerySync(
    db,
    database
      .selectFrom("plugin_blob_entries")
      .select(["created_at", "expires_at"])
      .where("plugin_id", "=", "diffs")
      .where("namespace", "=", "diff-artifacts")
      .where("entry_key", "=", id),
  ).rows[0];
  assert.ok(entry);
  assert.ok(entry.expires_at !== null);
  assert.equal(entry.expires_at - entry.created_at, expectedTtlMs);
  const result = executeSqliteQuerySync(
    db,
    database
      .updateTable("plugin_blob_entries")
      .set({ expires_at: 1 })
      .where("plugin_id", "=", "diffs")
      .where("namespace", "=", "diff-artifacts")
      .where("entry_key", "=", id),
  );
  assert.equal(Number(result.numAffectedRows), 1);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function ensureCuratedViewerRuntimeForTests(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimePath = path.join(repoRoot, "extensions", "diffs", "assets", "viewer-runtime.js");
  if (await pathExists(runtimePath)) {
    return;
  }

  // The curated runtime is generated output. Source tests that serve viewer
  // assets need a clean-checkout fixture before the normal build hook runs.
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/build-diffs-viewer-runtime.mts", "curated"],
    {
      cwd: repoRoot,
    },
  );
}

export async function createTempDiffRoot(prefix: string): Promise<{
  rootDir: string;
  cleanup: () => Promise<void>;
}> {
  const rootDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), prefix));
  return {
    rootDir,
    cleanup: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
}

export async function createDiffStoreHarness(
  prefix: string,
  options: { nativeKernel?: boolean } = {},
): Promise<{
  rootDir: string;
  store: DiffArtifactStore;
  blobStore: PluginBlobStore<DiffArtifactBlobMetadata>;
  reopen: () => Promise<{
    store: DiffArtifactStore;
    blobStore: PluginBlobStore<DiffArtifactBlobMetadata>;
  }>;
  cleanup: () => Promise<void>;
}> {
  const { rootDir: harnessRoot, cleanup } = await createTempDiffRoot(prefix);
  const rootDir = path.join(harnessRoot, "files");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(harnessRoot, "state"),
  };
  const storeOptions: OpenBlobStoreOptions = {
    namespace: "diff-artifacts",
    maxEntries: 2_048,
    maxBytesPerEntry: 32 * 1024 * 1024,
    maxBytesPerNamespace: 256 * 1024 * 1024,
    overflowPolicy: "reject-new",
  };
  const openBlobStore = () =>
    options.nativeKernel
      ? createPluginBlobKernelStore<DiffArtifactBlobMetadata>("diffs", { ...storeOptions, env })
      : createPluginBlobStoreForTests<DiffArtifactBlobMetadata>("diffs", storeOptions, env);
  const blobStore = openBlobStore();
  let store = new DiffArtifactStore({ rootDir, blobStore });
  return {
    rootDir,
    store,
    blobStore,
    reopen: async () => {
      await store.stopCleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginBlobStoreForTests();
      const reopenedBlobStore = openBlobStore();
      store = new DiffArtifactStore({ rootDir, blobStore: reopenedBlobStore });
      return {
        store,
        blobStore: reopenedBlobStore,
      };
    },
    cleanup: async () => {
      await store.stopCleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginBlobStoreForTests();
      await cleanup();
    },
  };
}
