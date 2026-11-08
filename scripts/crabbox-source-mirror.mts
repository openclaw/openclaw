import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../src/infra/kysely-sync.js";

const fileSchema = z.strictObject({
  path: z.string(),
  source: z.string(),
  stamp: z.string(),
  mode: z.enum(["100644", "100755", "120000"]),
  blob: z.string().regex(/^[0-9a-f]{40}$/u),
});
export type MirrorFile = z.infer<typeof fileSchema>;
const metadataSchema = z.strictObject({
  version: z.literal(1),
  gitVersion: z.string(),
  witness: z.string(),
  tracked: z.string(),
  inventory: z.array(z.tuple([z.string(), z.string()])),
});
type Metadata = z.infer<typeof metadataSchema>;
type MirrorDatabase = {
  files: MirrorFile;
  metadata: { id: number; value: string };
};

export function mirrorStatStamp(stat: Stats) {
  return [
    stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other",
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].join(":");
}

function mirrorArtifact(path: string) {
  return [".crabbox/runs", ".crabbox/captures"].some(
    (root) => path === root || path.startsWith(root + "/"),
  );
}

export function recordMirrorEntry(entries: Map<string, string>, path: string, stat: Stats) {
  if (mirrorArtifact(path)) {
    return;
  }
  // Native sync may refresh its index; selection/candidate indexes stay sealed.
  if (path === ".git/index") {
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("source mirror index is not a private regular file");
    }
    entries.set(path, "mutable-index");
  } else if (stat.isDirectory()) {
    if (path !== ".crabbox") {
      entries.set(path, `dir:${stat.dev}:${stat.ino}:${stat.mode}`);
    }
  } else if (stat.isFile() || stat.isSymbolicLink()) {
    entries.set(path, mirrorStatStamp(stat));
  } else {
    throw new Error("source mirror contains an unsupported file kind");
  }
}

function payloadInventory(directory: string) {
  const entries = new Map<string, string>();
  let objectBytes = 0;
  function walk(parent: string) {
    for (const name of readdirSync(join(directory, parent))) {
      const path = parent ? `${parent}/${name}` : name;
      // Run outputs belong to staging's preservation owner.
      if (mirrorArtifact(path)) {
        continue;
      }
      const stat = lstatSync(join(directory, path));
      recordMirrorEntry(entries, path, stat);
      if (stat.isDirectory()) {
        walk(path);
      } else if (path.startsWith(".git/objects/")) {
        objectBytes += stat.size;
      }
    }
  }
  walk("");
  return { entries, objectBytes };
}

/** A derived cache, opened only while the staging owner holds the mirror lock. */
export function openSourceMirror(
  root: string,
  directory: string,
  reused: boolean,
  context: { gitVersion: string; witness: string },
) {
  const databasePath = join(root, "mirror.sqlite");
  if (reused) {
    const stat = lstatSync(databasePath);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("source mirror metadata is not a private regular database");
    }
  }
  const db = new DatabaseSync(databasePath);
  const query = getNodeSqliteKysely<MirrorDatabase>(db);
  const files = new Map<string, MirrorFile>();
  let metadata: Metadata | undefined;
  try {
    if (reused) {
      // Receipt custody verifies the closed database bytes before opening it.
      // Every payload path must still match before any Git command can run here.
      const rows = executeSqliteQuerySync(db, query.selectFrom("metadata").selectAll()).rows;
      if (rows.length !== 1 || rows[0]?.id !== 1) {
        throw new Error("source mirror metadata is incomplete");
      }
      metadata = metadataSchema.parse(JSON.parse(rows[0].value));
      if (
        metadata.gitVersion !== context.gitVersion ||
        metadata.witness !== context.witness ||
        !context.witness
      ) {
        throw new Error("source mirror Git version or witness changed");
      }
      const { entries: current, objectBytes } = payloadInventory(directory);
      if (objectBytes > 256 * 1024 * 1024) {
        throw new Error("source mirror private Git objects reached the rebuild budget");
      }
      const expected = new Map(metadata.inventory);
      if (
        expected.size !== metadata.inventory.length ||
        expected.size !== current.size ||
        [...expected].some(([path, stamp]) => current.get(path) !== stamp)
      ) {
        throw new Error("source mirror payload changed outside its owner");
      }
      for (const row of executeSqliteQuerySync(db, query.selectFrom("files").selectAll()).rows) {
        const file = fileSchema.parse(row);
        if (expected.get(file.path) !== file.stamp || files.has(file.path)) {
          throw new Error("source mirror file metadata does not match its payload");
        }
        files.set(file.path, file);
      }
    } else {
      db.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE files (
          path TEXT PRIMARY KEY, source TEXT NOT NULL, stamp TEXT NOT NULL,
          mode TEXT NOT NULL, blob TEXT NOT NULL
        );
        CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
      `);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  const close = () => {
    if (!closed) {
      db.close();
      closed = true;
    }
  };
  return {
    files,
    tracked: metadata?.tracked,
    close,
    save(next: Map<string, MirrorFile>, tracked: string, inventory: Map<string, string>) {
      // Staging's final payload walk supplies these fresh observations. No payload
      // writes may follow it; both seals describe the same frozen filesystem.
      for (const [path, file] of next) {
        if (inventory.get(path) !== file.stamp) {
          throw new Error(
            `source mirror changed while freezing ${JSON.stringify(path)}; source was not uploaded`,
          );
        }
      }
      const value: Metadata = {
        version: 1,
        ...context,
        tracked,
        inventory: [...inventory],
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const path of files.keys()) {
          if (!next.has(path)) {
            executeSqliteQuerySync(db, query.deleteFrom("files").where("path", "=", path));
          }
        }
        const changed = [...next.values()].filter(
          (file) => JSON.stringify(file) !== JSON.stringify(files.get(file.path)),
        );
        // Bound SQLite parameters while cold population remains one transaction.
        for (let start = 0; start < changed.length; start += 256) {
          executeSqliteQuerySync(
            db,
            query
              .insertInto("files")
              .values(changed.slice(start, start + 256))
              .onConflict((conflict) =>
                conflict.column("path").doUpdateSet((eb) => ({
                  source: eb.ref("excluded.source"),
                  stamp: eb.ref("excluded.stamp"),
                  mode: eb.ref("excluded.mode"),
                  blob: eb.ref("excluded.blob"),
                })),
              ),
          );
        }
        executeSqliteQuerySync(
          db,
          query
            .insertInto("metadata")
            .values({ id: 1, value: JSON.stringify(value) })
            .onConflict((conflict) =>
              conflict.column("id").doUpdateSet({ value: JSON.stringify(value) }),
            ),
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        close();
      }
    },
  };
}
