import { DatabaseSync } from "node:sqlite";
import { load, getLoadablePath } from "sqlite-vec";

function vec(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

const db = new DatabaseSync(":memory:", { allowExtension: true });

try {
  load(db);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write("sqlite-vec load failed:\n");
  process.stderr.write(`${message}\n`);
  process.stderr.write(`expected extension path: ${getLoadablePath()}\n`);
  process.exit(1);
}

db.exec(`
  CREATE VIRTUAL TABLE v USING vec0(
    id TEXT PRIMARY KEY,
    embedding FLOAT[4]
  );
`);

const insert = db.prepare("INSERT INTO v (id, embedding) VALUES (?, ?)");
insert.run("a", vec([1, 0, 0, 0]));
insert.run("b", vec([0, 1, 0, 0]));
insert.run("c", vec([0.2, 0.2, 0, 0]));

const query = vec([1, 0, 0, 0]);
const rows = db
  .prepare("SELECT id, vec_distance_cosine(embedding, ?) AS dist FROM v ORDER BY dist ASC")
  .all(query);

process.stdout.write("sqlite-vec ok\n");
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
