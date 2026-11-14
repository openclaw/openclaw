import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lifecycle, ok, toStartIntent } from "./retained-repair-lifecycle-test-support.mjs";

// The lifecycle and acceptance owners publish every transaction/acceptance receipt.
// Only native service IO and the downstream start-condition receipt are synthetic;
// root/PID1 start authorization is covered by retained-repair-native-config.test.mjs.
export function completed(f) {
  const db = new DatabaseSync(f.databasePath);
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,repo_root TEXT,source TEXT,origin_url TEXT); CREATE TABLE agent_databases(agent_id TEXT PRIMARY KEY,path TEXT)");
  db.prepare("INSERT INTO projects VALUES('openclaw',?,'registered',NULL)").run(f.root);
  db.prepare("INSERT INTO agent_databases VALUES('controller-test-agent',?)").run(f.agentDatabasePath);
  db.close();
  let current = toStartIntent(f);
  lifecycle(f, "start-dispatch", current);
  const start = current.record.lifecycle.startIntent;
  writeFileSync(f.prefix + ".start-claim.json", JSON.stringify({ version: 1, kind: "retained-repair-start-claim",
    operation: current.record.operation, intent: current.journal, capability: start.capability, permit: start.permit }) + "\n", { mode: 0o600 });
  f.startSuccessor();
  current = lifecycle(f, "started", current, { instance: "fixture-successor-instance" });
  const initial = ok(f, "retained-repair-acceptance", "prepare", current.journal);
  assert.equal(initial.status, "PREPARED");
  // Synthetic sessions.create response persisted at its public storage boundary.
  const sessionId = "repair-marker-session", entry = { sessionId, projectId: "openclaw", spawnedCwd: f.root, sessionRoot: f.root };
  const agent = new DatabaseSync(f.agentDatabasePath);
  agent.prepare("INSERT INTO session_nodes VALUES(?,?,?,?,NULL)").run(initial.sessionKey, sessionId, JSON.stringify(entry), 2);
  agent.prepare("INSERT INTO session_windows VALUES(?,?)").run(sessionId, initial.sessionKey);
  agent.prepare("INSERT INTO transcript_rewrite_watermarks VALUES(?,?)").run(sessionId, "marker-generation");
  agent.close();
  const accepted = ok(f, "retained-repair-acceptance", "prepare", current.journal), payload = JSON.parse(accepted.payload);
  const route = { provider: "fixture", model: "exact-model" };
  f.env.OPENCLAW_TEAM_REPAIR_ACCEPTANCE_PROOF = JSON.stringify({
    reply: { runId: payload.idempotencyKey, status: "ok", stopReason: "stop", endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: initial.marker },
      terminalReceipt: { runId: payload.idempotencyKey, sessionId, turnId: "marker-turn", terminalDisposition: "visible", requested: route, effective: route } },
    markerPolicy: { model: "fixture/exact-model", fallbacks: [] },
    channels: { eventLoop: { degraded: false }, channelAccounts: Object.fromEntries(JSON.parse(f.env.OPENCLAW_TEAM_OPERATOR_PROFILE).channels.map(([name, accountId]) =>
      [name, [{ accountId, running: true, connected: true, lifecycle: "ready" }]])) },
    process: { pid: f.newPid, processInstanceId: "fixture-successor-instance" },
    checkout: { method: "projects.checkoutOptions", params: { projectId: "openclaw", agentId: "roboclaw" }, response: { current: true, worktree: false } },
  });
  const acceptance = ok(f, "retained-repair-acceptance", "receipt", current.journal);
  delete f.env.OPENCLAW_TEAM_REPAIR_ACCEPTANCE_PROOF;
  assert.equal(acceptance.status, "VERIFIED");
  current = lifecycle(f, "verify", current, { acceptance: acceptance.receipt });
  current = lifecycle(f, "complete", current);
  assert.equal(current.record.phase, "REPAIR_COMPLETED");
  assert.deepEqual(readFileSync(JSON.parse(readFileSync(f.completed.completed.path)).original.path), f.original);
  return current;
}

export function retire(f, state, { operation = f.request.operation, hash = state.journal.sha256, preload, shell = false } = {}) {
  const argv = shell ? ["bash", f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE, "--retire-retained-repair", operation, hash] :
    [process.execPath, "--no-warnings", "--import", f.preload, ...(preload ? ["--import", preload] : []), f.library,
      "retained-repair-retire", f.serving, operation, hash];
  return spawnSync("bash", ["-c", 'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"', "retirement-test", ...argv],
    { env: f.env, encoding: "utf8", timeout: 30000 });
}

export function interruptedRetirement(f, state, when) {
  const preload = join(f.root, "interrupt-retirement.mjs");
  writeFileSync(preload, 'import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module";\n' +
    'const original=fs.renameSync;fs.renameSync=function(from,to){if(from===' + JSON.stringify(f.journal) + ') {' +
    (when === "after" ? 'original.call(this,from,to);' : '') + 'process.exit(86);}return original.call(this,from,to)};syncBuiltinESMExports();\n');
  return retire(f, state, { preload });
}
