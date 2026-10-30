import fs from "node:fs/promises";
import path from "node:path";
import { createWorkerBundleProducer } from "../src/gateway/worker-environments/bundle.js";
import {
  PACKAGED_WORKER_BUNDLE_DIRECTORY,
  restorePackagedWorkerBundle,
} from "./package-worker-bundle-lifecycle.mjs";

/** Materializes the sealed worker graph as one content-addressed npm artifact. */
export async function preparePackagedWorkerBundle(cwd = process.cwd()): Promise<string> {
  const packageRoot = path.resolve(cwd);
  const archiveDirectory = path.join(packageRoot, PACKAGED_WORKER_BUNDLE_DIRECTORY);
  await restorePackagedWorkerBundle(packageRoot);
  await fs.mkdir(archiveDirectory, { recursive: true });
  try {
    const artifact = await createWorkerBundleProducer({
      packageRoot,
      cacheDir: archiveDirectory,
    }).prepare();
    const cachePath = path.join(archiveDirectory, `${artifact.bundleHash}.tgz`);
    if (path.resolve(artifact.tarballPath) !== cachePath) {
      throw new Error("Packaged worker bundle was written outside its owned artifact directory");
    }
    const packagedPath = path.join(archiveDirectory, `${artifact.bundleHash}.tar.gz`);
    await fs.rename(cachePath, packagedPath);
    return packagedPath;
  } catch (error) {
    await restorePackagedWorkerBundle(packageRoot);
    throw error;
  }
}
