import { fstatSync, lstatSync, opendirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STALE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_STALE_REMOVALS = 4;

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
      basename(path).startsWith("openclaw-pr-anchor.") &&
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
    const held = fstatSync(9, { bigint: true });
    const current = lstatSync(anchor.path, { bigint: true });
    if (
      !held.isDirectory() ||
      !current.isDirectory() ||
      realpathSync(anchor.path) !== anchor.path ||
      ![held, current].every(
        (value) =>
          value.dev === anchor.dev &&
          value.ino === anchor.ino &&
          value.uid === anchor.uid &&
          value.mode === anchor.mode,
      )
    ) {
      throw new Error("Anchor creation evidence changed");
    }
    // rm does not follow the materializer's external dependency symlinks.
    rmSync(anchor.path, { recursive: true });
  } catch {
    console.error("Warning: retaining the materialized PR wrapper after anchor cleanup failed.");
  }
}

export function sweepMaterializedAnchors(ownedAnchor) {
  let removed = 0;
  let failed = false;
  try {
    const directory = opendirSync(process.env.TMPDIR || "/tmp");
    try {
      let entry;
      while (removed < MAX_STALE_REMOVALS && (entry = directory.readSync())) {
        const match = /^openclaw-pr-anchor\.(?:([1-9][0-9]*)\.)?[A-Za-z0-9]+$/u.exec(entry.name);
        if (!match) {
          continue;
        }
        const path = join(directory.path, entry.name);
        try {
          const current = lstatSync(path, { bigint: true });
          if (
            !current.isDirectory() ||
            current.uid !== BigInt(process.getuid()) ||
            (current.mode & 0o7777n) !== 0o700n ||
            (ownedAnchor &&
              (resolve(path) === ownedAnchor.path ||
                (current.dev === ownedAnchor.dev && current.ino === ownedAnchor.ino))) ||
            Math.max(Number(current.mtimeMs), Number(current.ctimeMs)) >= Date.now() - STALE_AGE_MS
          ) {
            continue;
          }
          if (match[1]) {
            const pid = Number(match[1]);
            if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) {
              continue;
            }
            try {
              process.kill(pid, 0);
              continue;
            } catch (error) {
              if (error.code !== "ESRCH") {
                if (error.code !== "EPERM") {
                  failed = true;
                }
                continue;
              }
            }
          }
          // Accepted residual: a dead creator stands in for a drained operation,
          // and legacy names have no creator PID. Descendants still running more
          // than 24 hours after a crashed or undrained supervisor, or a legacy
          // operation that old, can lose their anchor; undrained operations keep
          // their PR locks. PID reuse in new names only delays cleanup.
          rmSync(path, { recursive: true });
          removed++;
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
            failed = true;
          }
        }
      }
    } finally {
      directory.closeSync();
    }
  } catch {
    failed = true;
  }
  if (removed) {
    console.error(`Removed ${removed} stale materialized PR wrapper directories.`);
  }
  if (failed) {
    console.error("Warning: unable to clean up some stale materialized PR wrappers.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "retire" && process.argv[3]) {
    retireMaterializedAnchor(claimMaterializedAnchor(process.argv[3], process.ppid));
  } else {
    console.error("materialized-anchor requires retire <script-path>");
    process.exitCode = 2;
  }
}
