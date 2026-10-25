// Synthetic predecessor recovery through the real journal worker, with Gateway custody.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { BASE_GATEWAY_BENCH_CONFIG } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    prepare: { type: "boolean", default: false },
    port: { type: "string", default: "41516" },
  },
});
assert(values.root, "--root must name an exclusively owned synthetic fixture directory");
const root = path.resolve(values.root);
const port = Number(values.port);
assert(Number.isInteger(port) && port >= 40000 && port <= 65535);
const stateDir = path.join(root, "state");
Object.assign(process.env, {
  HOME: root,
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_SKIP_CHANNELS: "1",
});
const phase = (name: string) => {
  if (process.env.SQLMEASURE_OUT) {
    writeFileSync(path.join(process.env.SQLMEASURE_OUT, "phase"), name);
  }
};
const states = ["completed", "failed", "interrupted", "cancelled"] as const;
const count = 20;
const fixturePath = path.join(root, "fixture.json");

if (values.prepare) {
  mkdirSync(root);
  const now = Date.now();
  writeFileSync(fixturePath, JSON.stringify({ now }));
  writeFileSync(
    process.env.OPENCLAW_CONFIG_PATH!,
    JSON.stringify({
      ...BASE_GATEWAY_BENCH_CONFIG,
      gateway: { ...BASE_GATEWAY_BENCH_CONFIG.gateway, port },
      cron: { enabled: false },
      memory: { search: { enabled: false } },
      plugins: { enabled: false },
      logging: { file: path.join(root, "gateway.log") },
      agents: { defaults: { model: "openai/gpt-4.1" } },
    }),
  );
  const { installDatabaseProcessRole } =
    await import("../../src/infra/database-engine/admission-scope.ts");
  installDatabaseProcessRole("cli-oneshot");
  const { NodeWorkerJournalWorker } =
    await import("../../src/node-host/node-worker-journal-worker.ts");
  const { NodeWorkerLaunchStore } = await import("../../src/node-host/node-worker-launch-store.ts");
  const { NodeWorkerTurnStore } = await import("../../src/node-host/node-worker-turn-store.ts");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
  const { resolveOpenClawStateSqlitePath } =
    await import("../../src/state/openclaw-state-db.paths.ts");
  const journal = new NodeWorkerJournalWorker({ env: process.env });
  const launches = new NodeWorkerLaunchStore(journal);
  const turns = new NodeWorkerTurnStore(journal);
  const supervisor = { pid: 17, startTime: 23 };
  try {
    for (let index = 0; index < count; index++) {
      const claim = {
        launchId: `synthetic-turn-${index}`,
        planHash: "a".repeat(64),
        gatewayNamespace: "synthetic-gateway",
        environmentId: `synthetic-environment-${index}`,
        sessionId: `synthetic-session-${index}`,
        ownerEpoch: 1,
        placementGeneration: 1,
        runId: `synthetic-run-${index}`,
      };
      await launches.claim(claim, supervisor, count, now);
      await turns.claim({ claim, ownerLaunchId: claim.launchId, supervisor, nowMs: now + index });
    }
  } finally {
    await journal.drain();
    await closeOpenClawStateDatabaseAsync();
  }
  // Exclusive offline predecessor: it knows the physical journal, not the turn table.
  const predecessor = new DatabaseSync(resolveOpenClawStateSqlitePath());
  try {
    const update = predecessor.prepare(
      "UPDATE node_worker_launches SET state = ?, error_text = ?, result_json = ?, completed_at_ms = ?, updated_at_ms = ? WHERE launch_id = ?",
    );
    for (let index = 0; index < count; index++) {
      const state = states[index % states.length]!;
      update.run(
        state,
        state === "completed" ? null : "synthetic predecessor",
        state === "completed" ? "{}" : null,
        now + 5,
        now + 5,
        `synthetic-turn-${index}`,
      );
    }
  } finally {
    predecessor.close();
  }
  console.log(JSON.stringify({ prepared: count }));
} else {
  const { now } = JSON.parse(readFileSync(fixturePath, "utf8")) as { now: number };
  phase("startup");
  const { startGatewayServer } = await import("../../src/gateway/server.ts");
  const gateway = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  const { NodeWorkerJournalWorker } =
    await import("../../src/node-host/node-worker-journal-worker.ts");
  const { NodeWorkerTurnStore } = await import("../../src/node-host/node-worker-turn-store.ts");
  const journal = new NodeWorkerJournalWorker({ env: process.env });
  const turns = new NodeWorkerTurnStore(journal);
  try {
    await gateway.startupSettled;
    for (const name of ["recovery", "warm"]) {
      phase(name);
      for (let index = 0; index < count; index++) {
        const receipt = await turns.get(`synthetic-turn-${index}`);
        const state = states[index % states.length]!;
        assert.equal(receipt?.state, state === "completed" ? "interrupted" : state);
        assert.equal(
          receipt?.errorText,
          state === "completed"
            ? "node worker stopped before its turn completed"
            : "synthetic predecessor",
        );
        assert.equal(receipt?.resultJson, null);
        assert.equal(receipt?.completedAtMs, now + Math.max(5, index));
        assert.equal(receipt?.updatedAtMs, receipt?.completedAtMs);
      }
    }
    console.log(JSON.stringify({ recovered: count, warm: count, outcomes: states }));
  } finally {
    phase("shutdown");
    await journal.drain();
    await gateway.close({ reason: "synthetic journal benchmark finished" });
  }
}
