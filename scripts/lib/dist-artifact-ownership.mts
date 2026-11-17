import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectRunUrl } from "./direct-run.mjs";
import {
  runOwnedDistArtifactEntry,
  withDistArtifactOwnership,
  resolveDistArtifactLockPath,
} from "./dist-artifact-lock.mts";
import {
  hasUnjoinedWork,
  runManagedCommand,
  type RunManagedCommandOptions,
} from "./managed-child-process.mts";
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

/** Bind an invocation artifact claim to the managed owner verified join. */
export async function runDistArtifactChild(
  rootDir: string,
  script: string,
  args: string[] = [],
  options: Pick<RunManagedCommandOptions, "cwd" | "env" | "stdio" | "signal" | "onReady"> & {
    native?: boolean;
  } = {},
): Promise<number> {
  return withDistArtifactOwnership(
    rootDir,
    async () => {
      // Keep the existing child-owned claim on Windows: the portable fallback has
      // no strict tree proof with which to retire a parent-owned claim.
      if (process.platform === "win32") {
        return runManagedCommand({
          bin: process.execPath,
          ...options,
          cwd: options.cwd ?? rootDir,
          args: distArtifactEntryArgs(script, args, options),
          // This is node.exe, not a command shim; preserve file URLs without cmd expansion.
          shell: false,
        });
      }
      const claim = `child-${randomUUID()}`;
      const claimPath = path.join(resolveDistArtifactLockPath(fs.realpathSync(rootDir)), claim);
      fs.writeFileSync(claimPath, "Awaiting managed child completion.\n", { flag: "wx" });
      let joined = true;
      try {
        const entryArgs = distArtifactEntryArgs(script, args, options);
        const entryIndex = entryArgs.indexOf(fileURLToPath(import.meta.url));
        entryArgs.splice(entryIndex + 1, 0, "--parent-claim", claim);
        return await runManagedCommand({
          bin: process.execPath,
          ...options,
          cwd: options.cwd ?? rootDir,
          args: entryArgs,
          requireProcessTreeExit: true,
        });
      } catch (error) {
        joined = !hasUnjoinedWork(error);
        throw error;
      } finally {
        if (joined) {
          fs.unlinkSync(claimPath);
        }
      }
    },
    options.signal,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const entryArgs = process.argv.slice(2);
  const parentClaim = entryArgs[0] === "--parent-claim" ? entryArgs.splice(0, 2)[1] : undefined;
  const [script, ...args] = entryArgs;
  // Complete this module's evaluation before importing commands that import it back.
  void runOwnedDistArtifactEntry(script!, args, parentClaim).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
