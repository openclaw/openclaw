import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import type { MemoryPublicationOperations } from "./manager-publication-task.js";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";

const databasePath = process.argv[2];
const serializedInput = process.argv[3];
assert.ok(databasePath && serializedInput);
const input = JSON.parse(
  serializedInput,
) as MemoryPublicationOperations["source.replace.group"]["input"];
const db = openNodeSqliteDatabase(databasePath);
db.exec(
  "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=2; PRAGMA cache_spill=ON",
);
const backend = bindSqliteWorkerBackend(
  { kind: "agent" },
  {
    databasePath,
    database: db,
    admit(stage) {
      if (stage === "commit") {
        writeSync(
          1,
          JSON.stringify({
            inTransaction: db.isTransaction,
            revision: db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()
              ?.revision,
            sources: db.prepare("SELECT path, hash FROM memory_index_sources ORDER BY path").all(),
            chunks: db
              .prepare("SELECT path, text FROM memory_index_chunks ORDER BY path, start_line")
              .all(),
          }),
        );
        process.kill(process.pid, "SIGKILL");
      }
    },
  },
);
try {
  const outcome = backend.execute({ type: "source.replace.group", input });
  throw new Error(`Expected process death before publication commit: ${JSON.stringify(outcome)}`);
} finally {
  backend.close();
  db.close();
}
