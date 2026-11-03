import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectRunUrl } from "./direct-run.mjs";
import { runOwnedDistArtifactEntry } from "./dist-artifact-lock.mts";
export { withDistArtifactOwnership, resolveDistArtifactLockPath } from "./dist-artifact-lock.mts";

/** Source launcher for a joined, separately sized Node child that reuses the lock owner. */
export function distArtifactEntryArgs(
  script: string,
  args: string[] = [],
  { native = false }: { native?: boolean } = {},
) {
  return [
    ...(native ? [] : ["--import", new URL("../tsx.mjs", import.meta.url).href]),
    fileURLToPath(import.meta.url),
    pathToFileURL(path.resolve(script)).href,
    ...args,
  ];
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const [script, ...args] = process.argv.slice(2);
  // Complete this module's evaluation before importing commands that import it back.
  void runOwnedDistArtifactEntry(script!, args).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
