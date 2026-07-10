/** Internal metadata-keyed cache shared by session loading and transcript rotation. */
import { statSync } from "node:fs";
import { resolve } from "node:path";

export interface SessionFileSnapshot {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface CachedSessionEntries {
  snapshot: SessionFileSnapshot;
  entries: unknown[];
  endsWithNewline: boolean;
}

export const sessionEntriesCache = new Map<string, CachedSessionEntries>();

export function readSessionFileSnapshot(filePath: string): SessionFileSnapshot {
  const fileStat = statSync(filePath, { bigint: true });
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeNs: fileStat.mtimeNs,
    ctimeNs: fileStat.ctimeNs,
  };
}

export function readSessionFileSnapshotIfExists(filePath: string): SessionFileSnapshot | undefined {
  try {
    return readSessionFileSnapshot(filePath);
  } catch {
    return undefined;
  }
}

export function isSameSessionFileSnapshot(
  left: SessionFileSnapshot,
  right: SessionFileSnapshot,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Return parsed rows only when a complete cache entry still matches the file. */
export function tryReadCachedSessionEntries(filePath: string): readonly unknown[] | undefined {
  const resolvedPath = resolve(filePath);
  const cached = sessionEntriesCache.get(resolvedPath);
  // Misses are common for external context engines. Avoid filesystem polling
  // unless this process already owns a complete parsed snapshot for the path.
  if (!cached) {
    return undefined;
  }

  const beforeSnapshot = readSessionFileSnapshotIfExists(resolvedPath);
  if (!beforeSnapshot || !isSameSessionFileSnapshot(cached.snapshot, beforeSnapshot)) {
    sessionEntriesCache.delete(resolvedPath);
    return undefined;
  }
  const afterSnapshot = readSessionFileSnapshotIfExists(resolvedPath);
  if (!afterSnapshot || !isSameSessionFileSnapshot(beforeSnapshot, afterSnapshot)) {
    sessionEntriesCache.delete(resolvedPath);
    return undefined;
  }
  // Cache producers deep-freeze each entry, but retain a mutable list so owned
  // appends can advance it. Do not expose that list's ownership to consumers.
  return cached.entries.slice();
}
