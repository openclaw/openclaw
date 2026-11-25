// Offline synthetic shape: 5,000 sessions, 35GiB SQLite padding, 62k files / 1.1GB.
// node scripts/perf/shutdown-loaded-fixture.mjs <new-directory-on-btrfs>
// Padding is compressible zeroblob data, not a production transcript distribution.
// The existing seed owner refuses an existing directory. The caller owns cleanup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

assert(process.argv[2], "Pass a new synthetic fixture directory");
const root = path.resolve(process.argv[2]);
const checkout = fileURLToPath(new URL("../../", import.meta.url));
execFileSync(
  process.execPath,
  [
    "--import",
    "./scripts/tsx.mjs",
    "scripts/perf/session-actor-retention-seed.ts",
    "--state-dir",
    root,
  ],
  { cwd: checkout, stdio: "inherit" },
);
const filename = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
const database = new DatabaseSync(filename);
let sessions;
try {
  sessions = database.prepare("SELECT count(*) AS count FROM session_nodes").get().count;
  assert(sessions >= 5000);
  database.exec(
    "PRAGMA journal_mode=DELETE; CREATE TABLE synthetic_shutdown_padding (payload BLOB)",
  );
  const insert = database.prepare("INSERT INTO synthetic_shutdown_padding VALUES (zeroblob(?))");
  for (let index = 0; index < 560; index++) {
    insert.run(64 * 1024 * 1024);
  }
} finally {
  database.close();
}
const workspace = path.join(root, "workspace");
mkdirSync(workspace);
const payload = Buffer.alloc(17742, 120);
for (let index = 0; index < 62000; index++) {
  writeFileSync(path.join(workspace, `synthetic-${index}`), payload);
}
const shape = {
  sessions,
  dbBytes: statSync(filename).size,
  dbAllocatedBytes: statSync(filename).blocks * 512,
  workspaceFiles: 62000,
  workspaceBytes: 62000 * payload.length,
  padding: "35GiB zeroblob, compressible synthetic payload",
};
console.log(JSON.stringify(shape));
writeFileSync(path.join(root, "shape.json"), JSON.stringify(shape, null, 2));
