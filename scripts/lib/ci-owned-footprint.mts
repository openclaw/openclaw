import { lstatSync, opendirSync, realpathSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

/** Metadata only. Inode blocks include shared reflink extents: never a deletion/reclaim receipt. */
export async function collectCiOwnedFootprint(
  roots: Record<string, string>,
  shouldStop = () => false,
) {
  const started = performance.now();
  const maxEntries = 250_000;
  const maxMs = 1_000;
  const seen = new Set<string>();
  let examined = 0;
  const exhausted = () =>
    shouldStop() || examined >= maxEntries || performance.now() - started >= maxMs;
  const measurements = [];
  for (const [label, root] of Object.entries(roots)) {
    let entries = 0;
    let logicalBytes = 0n;
    let inodeBlockBytes = 0n;
    let firstSeenInodeBlockBytes = 0n;
    let multiplyLinkedFiles = 0;
    let symlinks = 0;
    let errors = 0;
    let incomplete = false;
    const pending = [root];
    try {
      // Reject symlinked roots and ancestors; child symlinks are counted, never opened.
      if (realpathSync(root) !== resolve(root)) {
        pending.length = 0;
        incomplete = true;
      }
    } catch {
      pending.length = 0;
      errors++;
      incomplete = true;
    }
    while (pending.length) {
      if (exhausted()) {
        incomplete = true;
        break;
      }
      const file = pending.pop()!;
      examined++;
      entries++;
      try {
        const stat = lstatSync(file, { bigint: true });
        logicalBytes += stat.size;
        inodeBlockBytes += stat.blocks * 512n;
        const identity = `${stat.dev}:${stat.ino}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          firstSeenInodeBlockBytes += stat.blocks * 512n;
        }
        if (stat.isSymbolicLink()) {
          symlinks++;
        } else if (stat.isDirectory()) {
          const directory = opendirSync(file);
          try {
            for (let child = directory.readSync(); child; child = directory.readSync()) {
              if (examined + pending.length >= maxEntries || exhausted()) {
                incomplete = true;
                break;
              }
              pending.push(join(file, child.name));
              if (pending.length % 128 === 0) {
                await nextTurn();
              }
            }
          } finally {
            directory.closeSync();
          }
        } else if (stat.isFile() && stat.nlink > 1n) {
          multiplyLinkedFiles++;
        }
      } catch {
        errors++;
        incomplete = true;
      }
      // Cooperatively deliver signals; no detached scanner may outlive the invocation.
      if (examined % 128 === 0) {
        await nextTurn();
      }
    }
    measurements.push({
      label,
      entries,
      logicalBytes: String(logicalBytes),
      inodeBlockBytes: String(inodeBlockBytes),
      firstSeenInodeBlockBytes: String(firstSeenInodeBlockBytes),
      multiplyLinkedFiles,
      symlinks,
      errors,
      incomplete,
    });
  }
  return {
    nonAtomic: true,
    exclusiveExtentOwnershipMeasured: false,
    maxEntries,
    maxMs,
    examined,
    elapsedMs: Math.round(performance.now() - started),
    measurements,
  };
}

export function ciFilesystemCounters(root: string) {
  try {
    const volume = statfsSync(root, { bigint: true });
    return {
      availableBytes: String(volume.bavail * volume.bsize),
      freeInodes: String(volume.ffree),
    };
  } catch {
    return { unavailable: true };
  }
}
