// Add deterministic large payloads to already initialized, disposable agent stores.
// Usage: node scripts/perf/backup-verify-fixture.mjs <state-dir> <workspace-dir>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [stateDir, workspace] = process.argv.slice(2);
if (!stateDir || !workspace || !fs.existsSync(path.join(stateDir, "openclaw.json"))) {
  throw new Error("Supply a disposable initialized state directory and workspace directory.");
}
const block = Buffer.alloc(1024 * 1024, 32);
for (let offset = 0; offset < 256 * 1024; offset += 32) {
  createHash("sha256").update(`backup-fixture-${offset}`).digest().copy(block, offset);
}
const stores = [
  ["main", 4096],
  ["worker", 1024],
  ["research", 512],
];
for (const [agent, rows] of stores) {
  const file = path.join(stateDir, "agents", agent, "agent", "openclaw-agent.sqlite");
  if (!fs.existsSync(file)) {
    throw new Error(`Initialize the agent before inflation: ${file}`);
  }
  using db = new DatabaseSync(file);
  db.exec("CREATE TABLE backup_benchmark (id INTEGER PRIMARY KEY, payload BLOB NOT NULL); BEGIN");
  const insert = db.prepare("INSERT INTO backup_benchmark VALUES (?, ?)");
  for (let row = 0; row < rows; row++) {
    insert.run(row, block);
  }
  db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  console.log(JSON.stringify({ file, rows, size: fs.statSync(file).size }));
}
fs.mkdirSync(workspace, { recursive: true });
for (let index = 0; index < 12288; index++) {
  const dir = path.join(workspace, `project-${Math.floor(index / 128)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `document-${index}.bin`), block.subarray(0, 65536));
}
console.log(JSON.stringify({ workspaceFiles: 12288, workspaceBytes: 805306368 }));
