import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginBlobStore,
  resetPluginBlobStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolvePreferredOpenClawTmpDir } from "../api.js";
import { DiffArtifactStore, type DiffBlobMetadata } from "./store.js";

const MAX_TEST_DIFF_ARTIFACT_BLOBS = 512;

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
  options: { cleanupIntervalMs?: number } = {},
): Promise<{
  rootDir: string;
  store: DiffArtifactStore;
  cleanup: () => Promise<void>;
}> {
  const { rootDir, cleanup } = await createTempDiffRoot(prefix);
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = await fs.mkdtemp(path.join(rootDir, "state-"));
  resetPluginBlobStoreForTests();
  return {
    rootDir,
    store: new DiffArtifactStore({
      rootDir,
      cleanupIntervalMs: options.cleanupIntervalMs,
      blobStore: createPluginBlobStore<DiffBlobMetadata>("diffs", {
        namespace: "artifacts",
        maxEntries: MAX_TEST_DIFF_ARTIFACT_BLOBS,
      }),
    }),
    cleanup: async () => {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      resetPluginBlobStoreForTests();
      await cleanup();
    },
  };
}
