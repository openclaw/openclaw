import { rm } from "node:fs/promises";
import path from "node:path";

export const PACKAGED_WORKER_BUNDLE_DIRECTORY = "dist/worker-artifacts";

export async function restorePackagedWorkerBundle(cwd = process.cwd()) {
  await rm(path.join(cwd, PACKAGED_WORKER_BUNDLE_DIRECTORY), {
    recursive: true,
    force: true,
  });
}
