import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./vitest-pair-benchmark-contract.mts";
import type { VitestPairDeadline } from "./vitest-pair-benchmark.mts";

export type PreparedEntry =
  | { path: string; kind: "file"; bytes: number; sha256: string; mode: number }
  | { path: string; kind: "link"; target: string };

export async function inventoryPreparedWorkload(
  root: string,
  deadline: VitestPairDeadline,
): Promise<PreparedEntry[]> {
  deadline.throwIfExpired();
  if ((await realpath(root)) !== root) {
    throw new Error("Prepared workload must retain its physical root");
  }
  const result: PreparedEntry[] = [];
  const visit = async (directory: string) => {
    for (const name of (await readdir(directory)).toSorted()) {
      deadline.throwIfExpired();
      if (directory === root && name === ".git") {
        continue;
      }
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      const stat = await lstat(file);
      if (stat.isDirectory()) {
        await visit(file);
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(file);
        const physical = await realpath(file);
        const gitMetadata = path.join(root, ".git");
        if (physical === gitMetadata || physical.startsWith(gitMetadata + path.sep)) {
          throw new Error(`Prepared symlink targets excluded Git metadata: ${relative}`);
        }
        if (physical !== root && !physical.startsWith(root + path.sep)) {
          throw new Error(`Prepared symlink escapes workload: ${relative}`);
        }
        result.push({ path: relative, kind: "link", target });
      } else if (stat.isFile()) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(file, { signal: deadline.signal })) {
          deadline.throwIfExpired();
          hash.update(chunk);
        }
        result.push({
          path: relative,
          kind: "file",
          bytes: stat.size,
          sha256: hash.digest("hex"),
          mode: stat.mode & 0o777,
        });
      } else {
        throw new Error(`Prepared workload contains a special file: ${relative}`);
      }
    }
  };
  await visit(root);
  return result.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function preparedInventoryDelta(before: PreparedEntry[], after: PreparedEntry[]) {
  const old = new Map(before.map((entry) => [entry.path, entry]));
  const current = new Map(after.map((entry) => [entry.path, entry]));
  const added = after.filter((entry) => !old.has(entry.path));
  const removed = before.filter((entry) => !current.has(entry.path));
  const changed = after.filter(
    (entry) => old.has(entry.path) && JSON.stringify(old.get(entry.path)) !== JSON.stringify(entry),
  );
  return {
    beforeSha256: sha256(JSON.stringify(before)),
    afterSha256: sha256(JSON.stringify(after)),
    counts: {
      before: before.length,
      after: after.length,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
    },
    // These are complete metadata deltas, never file contents.
    added,
    removed,
    changed,
  };
}
