import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const stagingPrefix = "openclaw-crabbox-sync-";
const gitRoutingKeys = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);

function prospectiveDirectory(directory: string) {
  let ancestor = resolve(directory);
  const missing: string[] = [];
  for (let depth = 0; depth < 128; depth += 1) {
    try {
      const physical = realpathSync(ancestor);
      if (!statSync(physical).isDirectory()) {
        return undefined;
      }
      accessSync(physical, constants.R_OK | constants.X_OK);
      return resolve(physical, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return undefined;
      }
      // A dangling link has an unknown destination, not a missing path suffix.
      if (lstatSync(ancestor, { throwIfNoEntry: false })) {
        return undefined;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        return undefined;
      }
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  return undefined;
}

function overlaps(left: string, right: string) {
  // Ambiguous host casing makes registration ineligible, including on a
  // case-sensitive volume on these hosts. Ordinary staging remains available.
  const foldCase = process.platform === "darwin" || process.platform === "win32";
  const leftPath = foldCase ? left.toLowerCase() : left;
  const rightPath = foldCase ? right.toLowerCase() : right;
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  return contains(leftPath, rightPath) || contains(rightPath, leftPath);
}

/**
 * Optional recovery registration; false must never prevent ordinary staging.
 * This checks the selected source/workspace only. Arbitrary extra host mounts
 * are not isolated by recovery registration, and no host tree is traversed.
 */
export function canRecordStaging(
  exactProspectiveStageRoot: string,
  repository: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const source = realpathSync(repository);
    if (!statSync(source).isDirectory()) {
      return false;
    }
    accessSync(source, constants.R_OK | constants.X_OK);
    const stage = prospectiveDirectory(exactProspectiveStageRoot);
    if (!stage || overlaps(stage, source)) {
      return false;
    }
    // Native execution changes cwd to payload/source. Relative explicit Git
    // routing can therefore select a different workspace after this probe.
    for (const [key, value] of Object.entries(env)) {
      const upper = key.toUpperCase();
      if (value && (upper === "GIT_DIR" || upper === "GIT_WORK_TREE") && !isAbsolute(value)) {
        return false;
      }
    }
    // Native Crabbox keeps explicit repository routing but strips index/config
    // overrides. Those overrides must not make this optional check certify a
    // narrower workspace than the eventual native source enumeration uses.
    const gitEnv = Object.fromEntries(
      Object.entries(env).filter(([key]) => {
        const upper = key.toUpperCase();
        return !upper.startsWith("GIT_") || gitRoutingKeys.has(upper);
      }),
    );
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: source,
      env: { ...gitEnv, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0 || !isUtf8(result.stdout)) {
      return false;
    }
    const workspace = result.stdout.toString("utf8").replace(/\r?\n$/u, "");
    if (!isAbsolute(workspace)) {
      return false;
    }
    const physicalWorkspace = realpathSync(workspace);
    if (!statSync(physicalWorkspace).isDirectory()) {
      return false;
    }
    accessSync(physicalWorkspace, constants.R_OK | constants.X_OK);
    return !overlaps(stage, physicalWorkspace);
  } catch {
    // Unknown placement, permissions, or Git context only disables recording.
    return false;
  }
}
