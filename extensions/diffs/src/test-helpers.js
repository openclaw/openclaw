import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DiffArtifactStore } from "./store.js";
async function createTempDiffRoot(prefix) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    rootDir,
    cleanup: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  };
}
async function createDiffStoreHarness(prefix) {
  const { rootDir, cleanup } = await createTempDiffRoot(prefix);
  return {
    rootDir,
    store: new DiffArtifactStore({ rootDir }),
    cleanup
  };
}
export {
  createDiffStoreHarness,
  createTempDiffRoot
};
