import path from "node:path";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  openNodeSqliteDatabase,
  readSqliteDatabaseWriteTokenForPath,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("publishes settled write tokens and fresh facts for scalar autocommits", () => {
  const filename = path.join(tempDirs.make("memory-publication-scalar-"), "index.sqlite");
  const db = openNodeSqliteDatabase(filename);
  const backend = bindSqliteWorkerBackend(
    { kind: "agent" },
    { databasePath: filename, database: db, admit: () => undefined },
  );
  try {
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    db.exec(`INSERT INTO memory_index_sources(path, source, hash, mtime, size)
      VALUES ('sessions/current', 'sessions', 'old', 1, 1)`);
    let before = readSqliteDatabaseWriteTokenForPath(filename);
    expect(before).toEqual(expect.any(String));
    for (const model of ["initial-model", "replacement-model"]) {
      const metadata = { provider: "test", model, chunkTokens: 400, chunkOverlap: 80 };
      const outcome = backend.execute({ type: "index.writeMetadata", input: metadata });
      const current = readSqliteDatabaseWriteTokenForPath(filename);
      expect(current).not.toBe(before);
      expect(outcome).toMatchObject({ ok: true, writeToken: current, facts: { meta: metadata } });
      expect(
        db.prepare("SELECT value FROM memory_index_meta WHERE key = ?").get("memory_index_meta_v1"),
      ).toEqual({ value: JSON.stringify(metadata) });
      before = current;
    }
    const outcome = backend.execute({
      type: "source.refresh",
      input: { path: "sessions/current", hash: "new", mtime: 2, size: 2, expectedHash: "old" },
    });
    const current = readSqliteDatabaseWriteTokenForPath(filename);
    expect(current).not.toBe(before);
    expect(outcome).toMatchObject({ ok: true, value: true, writeToken: current });
    expect(db.prepare("SELECT hash, mtime, size FROM memory_index_sources").get()).toEqual({
      hash: "new",
      mtime: 2,
      size: 2,
    });
  } finally {
    backend.close();
    db.close();
  }
});
