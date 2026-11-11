import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SqliteIdentityStore } from "./identity-store.js";
import { StorageBase } from "./storage-base.js";
import { createVault, plainAccess, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

it("reads observation metadata once per scan while retaining rename, deletion and restoration revisions", async () => {
  const { config, root } = await createVault(tempDirs.make("knowledge-observe-"), {
    writesEnabled: false,
  });
  let reads = 0;
  let writerReads = 0;
  class CountingStore extends SqliteIdentityStore {
    override withDatabase<T>(run: (db: DatabaseSync) => T): T {
      return super.withDatabase((db) => {
        const prepare = db.prepare.bind(db);
        db.prepare = (sql) => {
          const statement = prepare(sql);
          const writer = sql.startsWith("SELECT provenance,agent_id,sequence FROM history");
          if (writer || /^SELECT .* FROM "?observations"?\b/i.test(sql)) {
            const count = <Method extends (...args: never[]) => unknown>(method: Method): Method =>
              new Proxy(method, {
                apply(target, receiver, args) {
                  if (writer) {
                    writerReads++;
                  } else {
                    reads++;
                  }
                  return Reflect.apply(target, receiver, args);
                },
              });
            statement.get = count(statement.get.bind(statement));
            statement.all = count(statement.all.bind(statement));
            statement.iterate = count(statement.iterate.bind(statement));
          }
          return statement;
        };
        return run(db);
      });
    }
  }
  const store = new CountingStore(config.statePath),
    storage = new StorageBase(config, store);
  const access = plainAccess();
  await mkdir(path.join(root, "private", "notes"));
  const raw = (id: string) =>
    `---\n${JSON.stringify({
      format: "knowledge-record-v1",
      id,
      revision: 1,
      kind: "page",
      type: "note",
      title: id,
      scope: access.scope,
      recorded_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      lifecycle: "active",
    })}\n---\nSynthetic note.\n`;
  const a = path.join(root, "private", "notes", "record-a.md"),
    b = path.join(root, "private", "notes", "record-b.md");
  await writeFile(a, raw("record-a"));
  await writeFile(b, raw("record-b"));
  const scan = async () => {
    reads = 0;
    const result = await storage.run(access, (vault) => vault.scan());
    expect(result.issues).toEqual([]);
    expect(reads).toBe(1);
    return result.records
      .map(({ id, revision }) => ({ id, revision }))
      .toSorted((left, right) => left.id.localeCompare(right.id));
  };
  expect(await scan()).toEqual([
    { id: "record-a", revision: 1 },
    { id: "record-b", revision: 1 },
  ]);
  expect(writerReads).toBe(0);
  await rename(a, a + "-renamed.md");
  await rm(b);
  expect(await scan()).toEqual([{ id: "record-a", revision: 2 }]);
  expect(writerReads).toBe(0);
  await writeFile(b, raw("record-b"));
  expect(await scan()).toEqual([
    { id: "record-a", revision: 2 },
    { id: "record-b", revision: 3 },
  ]);
  store.withDatabase((db) => {
    expect(
      db
        .prepare("SELECT provenance,revision FROM history WHERE id='record-b' ORDER BY sequence")
        .all(),
    ).toEqual([
      { provenance: "observed", revision: 1 },
      { provenance: "external-unavailable", revision: 2 },
      { provenance: "external-edit", revision: 3 },
    ]);
  });
  await rm(a + "-renamed.md");
  await rm(b);
  expect(await scan()).toEqual([]);
});
