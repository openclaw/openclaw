import { fstatSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANCHOR_PREFIX, claimCreatedAnchor, retireAnchorDependencies } from "./cache-lifetime.mjs";

// The creator keeps its PID across bash -> anchored bash -> supervisor execs.
// Neither an inherited pathname nor a child process grants deletion authority.
export function claimMaterializedAnchor(script, creatorPid = process.pid) {
  if (
    process.env.OPENCLAW_PR_ANCHOR_CREATOR_PID !== String(creatorPid) ||
    process.env.OPENCLAW_PR_ANCHOR_FD !== "9"
  ) {
    return undefined;
  }
  try {
    const path = dirname(dirname(resolve(script)));
    const held = fstatSync(9, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (
      basename(path).startsWith(ANCHOR_PREFIX) &&
      resolve(script) === join(path, "scripts", "pr") &&
      realpathSync(path) === path &&
      realpathSync(script) === resolve(script) &&
      realpathSync(fileURLToPath(import.meta.url)) ===
        join(path, "scripts", "pr-lib", "materialized-anchor.mjs") &&
      held.isDirectory() &&
      current.isDirectory() &&
      held.dev === current.dev &&
      held.ino === current.ino &&
      held.uid === BigInt(process.getuid()) &&
      (held.mode & 0o777n) === 0o700n &&
      held.mode === current.mode &&
      held.uid === current.uid
    ) {
      return { path, dev: held.dev, ino: held.ino, uid: held.uid, mode: held.mode };
    }
  } catch {
    // Missing or replaced creation evidence is retain-only.
  }
  return undefined;
}

export function retireMaterializedAnchor(anchor) {
  if (!anchor) {
    return;
  }
  try {
    // rm does not follow the materializer's external dependency symlinks.
    retireAnchorDependencies(anchor, () => rmSync(anchor.path, { recursive: true }));
  } catch {
    console.error("Warning: retaining the materialized PR wrapper after anchor cleanup failed.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "retire-created" && process.argv[3]) {
    try {
      retireMaterializedAnchor(claimCreatedAnchor(process.argv[3], process.ppid));
    } catch {
      console.error("Warning: retaining PR anchor whose creation evidence differs.");
    }
  } else if (process.argv[2] === "retire" && process.argv[3]) {
    retireMaterializedAnchor(claimMaterializedAnchor(process.argv[3], process.ppid));
  } else {
    console.error(
      "materialized-anchor requires retire <script-path> or retire-created <anchor-path>",
    );
    process.exitCode = 2;
  }
}
