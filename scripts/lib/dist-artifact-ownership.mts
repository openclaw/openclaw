// Source-checkout entry adapter; compiled runtime callers import dist-artifact-lock.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectRunUrl } from "./direct-run.mjs";
import { distArtifactParentBinding, runOwnedDistArtifactEntry } from "./dist-artifact-lock.mts";
import type { DistArtifactEntryOptions } from "./runtime-artifact-contract.js";

export {
  acquireDistArtifactOwnership,
  resolveDistArtifactLockPath,
  withDistArtifactOwnership,
} from "./dist-artifact-lock.mts";

/** An owning orchestrator joins this child before releasing checkout ownership. */
export function distArtifactEntryArgs(
  script: string,
  args: string[] = [],
  { native = false, rootDir = process.cwd(), parent }: DistArtifactEntryOptions = {},
) {
  return [
    ...(native ? [] : ["--import", new URL("../tsx.mjs", import.meta.url).href]),
    fileURLToPath(import.meta.url),
    JSON.stringify(parent ?? distArtifactParentBinding(rootDir)),
    pathToFileURL(path.resolve(script)).href,
    ...args,
  ];
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const [parent, script, ...args] = process.argv.slice(2);
  // Complete evaluation before importing commands that import this adapter back.
  void runOwnedDistArtifactEntry(parent!, script!, args, distArtifactEntryArgs).catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
