import nodeFs, { type FSWatcher, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import type { CodexCatalogRolloutFingerprint } from "./session-catalog-index-row.js";
import { CODEX_CATALOG_MAX_ROWS, detachCodexCatalogString } from "./session-catalog-limits.js";
import { MAX_CWD_LENGTH } from "./session-catalog-parsing.js";
import { codexCatalogRolloutLogicalPath } from "./session-catalog-rollouts.js";

const DIRECTORY_PARTS = [/^\d{4}$/, /^(?:0[1-9]|1[0-2])$/, /^(?:0[1-9]|[12]\d|3[01])$/];
const ROLLOUT_FILE_NAME = /\.jsonl(?:\.zst)?$/;
const MAX_WATCHED_DIRECTORIES = 256;
const SCAN_BATCH_SIZE = 64;
const DARWIN_WATCH_ARM_MS = 250;

export type CodexCatalogRolloutScan = {
  files: Map<string, CodexCatalogRolloutFingerprint>;
  present: Set<string>;
};
type RolloutCandidate = [string, CodexCatalogRolloutFingerprint];

function compareRolloutCandidates(left: RolloutCandidate, right: RolloutCandidate): number {
  return (
    left[1].mtimeMs - right[1].mtimeMs || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
  );
}

/** Retain only the newest fingerprints while streaming an arbitrarily large home. */
class NewestRolloutCandidates {
  private readonly heap: RolloutCandidate[] = [];

  offer(candidate: RolloutCandidate): void {
    if (this.heap.length < CODEX_CATALOG_MAX_ROWS) {
      let childIndex = this.heap.length;
      this.heap.push(candidate);
      while (childIndex > 0) {
        const parentIndex = Math.floor((childIndex - 1) / 2);
        const parent = this.heap[parentIndex];
        if (!parent || compareRolloutCandidates(parent, candidate) <= 0) {
          break;
        }
        this.heap[childIndex] = parent;
        childIndex = parentIndex;
      }
      this.heap[childIndex] = candidate;
      return;
    }
    const oldest = this.heap[0];
    if (!oldest || compareRolloutCandidates(candidate, oldest) <= 0) {
      return;
    }
    let parentIndex = 0;
    while (true) {
      let childIndex = parentIndex * 2 + 1;
      let child = this.heap[childIndex];
      if (!child) {
        break;
      }
      const right = this.heap[childIndex + 1];
      if (right && compareRolloutCandidates(right, child) < 0) {
        child = right;
        childIndex++;
      }
      if (compareRolloutCandidates(candidate, child) <= 0) {
        break;
      }
      this.heap[parentIndex] = child;
      parentIndex = childIndex;
    }
    this.heap[parentIndex] = candidate;
  }

  finish(): Map<string, CodexCatalogRolloutFingerprint> {
    this.heap.sort((left, right) => compareRolloutCandidates(right, left));
    return new Map(this.heap);
  }
}

/** Absence is meaningful only inside the layout visited by the currency scan. */
export function isCodexCatalogRolloutPathCovered(
  sessionsRoot: string,
  rolloutPath: string,
): boolean {
  const directories = path.relative(sessionsRoot, rolloutPath).split(path.sep);
  const fileName = directories.pop();
  return (
    fileName !== undefined &&
    ROLLOUT_FILE_NAME.test(fileName) &&
    directories.length === DIRECTORY_PARTS.length &&
    directories.every((part, index) => DIRECTORY_PARTS[index]?.test(part) === true)
  );
}

async function unlessMissing<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

type CachedDirectory = {
  watcher: FSWatcher;
  dirty: boolean;
  armAt: number;
  stat: Stats;
  files: Map<string, CodexCatalogRolloutFingerprint>;
};

/** The resident home owns a bounded watcher cache; unwatchable leaves are scanned in full. */
export class CodexCatalogRolloutScanner {
  private readonly directories = new Map<string, CachedDirectory>();
  private cachedFiles = 0;
  private running: Promise<CodexCatalogRolloutScan> | undefined;
  private closed = false;

  constructor(private readonly sessionsRoot: string) {}

  scan(trackedPaths: ReadonlySet<string>): Promise<CodexCatalogRolloutScan> {
    const previous = this.running;
    const running = (async () => {
      await previous?.catch(() => undefined);
      // Deliver pending watcher notifications before consulting a cached fingerprint.
      await nextTurn();
      try {
        return await this.walk(trackedPaths);
      } catch (error) {
        for (const cached of this.directories.values()) {
          cached.dirty = true;
        }
        throw error;
      }
    })();
    this.running = running;
    return running.finally(() => {
      if (this.running === running) {
        this.running = undefined;
      }
    });
  }

  private forget(directory: string): void {
    const cached = this.directories.get(directory);
    if (cached) {
      this.cachedFiles -= cached.files.size;
      this.directories.delete(directory);
      cached.watcher.close();
    }
  }

  private watch(directory: string, stat: Stats): CachedDirectory | undefined {
    if (
      this.closed ||
      directory.length > MAX_CWD_LENGTH ||
      this.directories.size >= MAX_WATCHED_DIRECTORIES
    ) {
      return undefined;
    }
    try {
      const watcher = nodeFs.watch(directory, { persistent: false });
      const cached: CachedDirectory = {
        watcher,
        stat,
        dirty: true,
        // FSEvents attaches asynchronously; a scan started after this window closes the gap.
        armAt: process.platform === "darwin" ? performance.now() + DARWIN_WATCH_ARM_MS : 0,
        files: new Map(),
      };
      watcher.on("change", () => {
        cached.dirty = true;
      });
      // A failed watch cannot certify freshness, even when directory mtimes match.
      const withdraw = () => {
        if (this.directories.get(directory) === cached) {
          this.forget(directory);
        }
      };
      watcher.on("error", withdraw);
      watcher.on("close", withdraw);
      this.directories.set(directory, cached);
      return cached;
    } catch {
      return undefined;
    }
  }

  private async walk(trackedPaths: ReadonlySet<string>): Promise<CodexCatalogRolloutScan> {
    if (this.closed) {
      throw new Error("Codex catalog rollout scanner is closed");
    }
    const present = new Set<string>();
    const unvisited = new Set(this.directories.keys());
    const candidates = new NewestRolloutCandidates();
    let processed = 0;
    const offer = (file: string, fingerprint: CodexCatalogRolloutFingerprint) => {
      if (trackedPaths.has(codexCatalogRolloutLogicalPath(file))) {
        present.add(codexCatalogRolloutLogicalPath(file));
      }
      candidates.offer([file, fingerprint]);
    };
    const scan = async (directory: string, depth: number, rootReal: string): Promise<void> => {
      if (this.closed) {
        throw new Error("Codex catalog rollout scanner is closed");
      }
      // Identity checks prevent reuse after a leaf or ancestor is replaced by a symlink.
      if ((await unlessMissing(fs.realpath(directory))) !== directory) {
        return;
      }
      const directoryPattern = DIRECTORY_PARTS[depth];
      const stat = !directoryPattern ? await unlessMissing(fs.lstat(directory)) : undefined;
      // The watch may have failed while the directory stat was pending.
      let cached = this.directories.get(directory);
      if (!directoryPattern) {
        if (!stat?.isDirectory() || stat.isSymbolicLink()) {
          return;
        }
        unvisited.delete(directory);
        if (cached && !sameDirectory(cached.stat, stat)) {
          this.forget(directory);
          cached = undefined;
        }
        if (cached && !cached.dirty) {
          for (const [file, fingerprint] of cached.files) {
            offer(file, fingerprint);
            if (++processed % SCAN_BATCH_SIZE === 0) {
              await nextTurn();
            }
          }
          return;
        }
        cached ??= this.watch(directory, stat);
      }
      if (cached) {
        // A change during this read schedules a fresh scan on the next reconciliation.
        cached.dirty = performance.now() < cached.armAt;
      }
      const retained = cached ? new Map<string, CodexCatalogRolloutFingerprint>() : undefined;
      let cacheable = true;
      const entries = await unlessMissing(fs.opendir(directory));
      if (!entries) {
        this.forget(directory);
        return;
      }
      for await (const entry of entries) {
        if (this.closed) {
          throw new Error("Codex catalog rollout scanner is closed");
        }
        if (++processed % SCAN_BATCH_SIZE === 0) {
          await nextTurn();
        }
        const file = path.join(directory, entry.name);
        if (directoryPattern) {
          if (entry.isDirectory() && directoryPattern.test(entry.name)) {
            await scan(file, depth + 1, rootReal);
          }
        } else if (entry.isFile() && ROLLOUT_FILE_NAME.test(entry.name)) {
          const fileStat = await unlessMissing(fs.lstat(file));
          if (!fileStat?.isFile() || fileStat.nlink !== 1) {
            continue;
          }
          const physicalPath = path.join(this.sessionsRoot, path.relative(rootReal, file));
          if (physicalPath.length > MAX_CWD_LENGTH) {
            continue;
          }
          const logicalPath = codexCatalogRolloutLogicalPath(physicalPath);
          if (physicalPath !== logicalPath) {
            const plain = await unlessMissing(fs.lstat(codexCatalogRolloutLogicalPath(file)));
            if (plain?.isFile() && plain.nlink === 1) {
              continue;
            }
          }
          const fingerprint = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
          const detached = detachCodexCatalogString(physicalPath);
          offer(detached, fingerprint);
          if (retained && cacheable) {
            retained.set(detached, fingerprint);
            if (
              this.cachedFiles - (cached?.files.size ?? 0) + retained.size >
              CODEX_CATALOG_MAX_ROWS
            ) {
              cacheable = false;
              retained.clear();
            }
          }
        }
      }
      if (cached && retained && stat) {
        if (cacheable && !this.closed && this.directories.get(directory) === cached) {
          this.cachedFiles += retained.size - cached.files.size;
          cached.files = retained;
          cached.stat = stat;
        } else {
          this.forget(directory);
        }
      }
    };
    const rootStat = await unlessMissing(fs.lstat(this.sessionsRoot));
    if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()) {
      const rootReal = await unlessMissing(fs.realpath(this.sessionsRoot));
      if (rootReal) {
        await scan(rootReal, 0, rootReal);
      }
    }
    for (const directory of unvisited) {
      this.forget(directory);
    }
    return { files: candidates.finish(), present };
  }

  close(): void {
    this.closed = true;
    for (const directory of this.directories.keys()) {
      this.forget(directory);
    }
  }
}
