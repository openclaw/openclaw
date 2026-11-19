// Synthetic discovery + history-page reads through real workers. No operator state.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-candidate-settlement-measure.mjs \
//   --state /absolute/new-fixture --seed --output /absolute/result.json
// Repeat without --seed, alternating --owner-file frozen-baseline.ts and current source.
// Timing acceptance: fewer cleanup requests/allocations, equal pages and admission charges,
// no >=20% median/p95 CPU or latency regression; five pairs plus baseline A/A controls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    state: { type: "string" },
    output: { type: "string" },
    "owner-file": { type: "string" },
    seed: { type: "boolean" },
    iterations: { type: "string", default: "100" },
    allocations: { type: "boolean" },
  },
});
assert(values.state && values.output, "--state and --output are required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = path.resolve(values.state);
const marker = path.join(root, "synthetic-candidate-benchmark");
if (values.seed) {
  fs.mkdirSync(root);
  fs.writeFileSync(marker, "synthetic-only\n");
  fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
}
assert.equal(fs.readFileSync(marker, "utf8"), "synthetic-only\n");
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_HOME: root,
});
const env = {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  HOME: root,
};
const owner = new URL(
  "../../src/config/sessions/session-transcript-worker-resources.ts",
  import.meta.url,
);
const source = values["owner-file"] ? pathToFileURL(path.resolve(values["owner-file"])) : owner;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ownerHash = sha256(fs.readFileSync(source));
registerHooks({
  load(url, context, nextLoad) {
    return nextLoad(url === owner.href ? source.href : url, context);
  },
});
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.ts");
const config = { agents: { list: ["main", "alpha", "beta", "gamma"].map((id) => ({ id })) } };
setRuntimeConfigSnapshot(config);
const { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
const { resolveOpenClawAgentSqlitePath } =
  await import("../../src/state/openclaw-agent-db.paths.ts");
const { replaceTranscriptEventsSync } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.ts");
const { waitForSessionTranscriptIndexReconcilesInStateDir } =
  await import("../../src/config/sessions/session-transcript-reconcile.ts");
const { prepareSessionStoreTargetInventory } =
  await import("../../src/config/sessions/session-store-target-inventory.ts");
const { prepareSessionStoreTargetInventoryRead } =
  await import("../../src/config/sessions/session-store-target-runtime.ts");
const { withSessionHistoryWorkerDatabase } =
  await import("../../src/config/sessions/session-transcript-worker-runtime.ts");
const { readSessionHistoryPageInWorker } =
  await import("../../src/config/sessions/session-history-worker-runtime.ts");
const { historyLane, sessionStoreLane, rotateDatabaseWorkers } = await import(owner.href);
const targets = config.agents.list.map(({ id: agentId }) => ({
  agentId,
  path: resolveOpenClawAgentSqlitePath({ agentId }),
}));
const scope = (target) => ({
  agentId: target.agentId,
  storePath: target.path,
  sessionId: "synthetic-0",
  sessionKey: `agent:${target.agentId}:synthetic-0`,
  env,
});
if (values.seed) {
  for (const target of targets) {
    runOpenClawAgentWriteTransaction(({ db }) => {
      const node = db.prepare(`INSERT INTO session_nodes
        (session_key,current_session_id,entry_json,updated_at,status,entry_valid)
        VALUES (?,?,?,?,'done',1)`);
      const window = db.prepare(`INSERT INTO session_windows
        (session_id,session_key,created_at,updated_at,transcript_updated_at,status)
        VALUES (?,?,?,?,?,'done')`);
      for (let i = 0; i < 1250; i++) {
        const id = `synthetic-${i}`,
          key = `agent:${target.agentId}:${id}`;
        node.run(
          key,
          id,
          JSON.stringify({ sessionId: id, updatedAt: i + 1, status: "done" }),
          i + 1,
        );
        window.run(id, key, i + 1, i + 1, i + 1);
      }
    }, target);
    replaceTranscriptEventsSync(scope(target), [
      { type: "session", id: "synthetic-0", version: 3 },
      ...Array.from({ length: 100 }, (_, i) => ({
        type: "message",
        id: `message-${i}`,
        parentId: i ? `message-${i - 1}` : null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: i % 2 ? "assistant" : "user",
          content: [{ type: "text", text: `Synthetic ${i}` }],
        },
      })),
    ]);
  }
  await waitForSessionTranscriptIndexReconcilesInStateDir(root);
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
const inventory = prepareSessionStoreTargetInventory(
  config,
  targets.map((t) => t.agentId),
  env,
);
const discovery = prepareSessionStoreTargetInventoryRead(inventory, undefined, []);
const charges = [];
let closures = 0;
let cleanupMs = 0;
const run = sessionStoreLane.pool.run.bind(sessionStoreLane.pool);
sessionStoreLane.pool.run = (prepare, options) => {
  charges.push(options.inputBytes);
  return run(prepare, options);
};
const close = sessionStoreLane.pool.closeResources.bind(sessionStoreLane.pool);
sessionStoreLane.pool.closeResources = async (...args) => {
  closures++;
  const at = performance.now();
  try {
    return await close(...args);
  } finally {
    cleanupMs += performance.now() - at;
  }
};
let expected;
const read = () =>
  discovery.withRead(async (sources) => {
    assert.equal(sources.agents.length, 4);
    for (const target of targets) {
      const present = await withSessionHistoryWorkerDatabase(
        target,
        (reader) => reader.readEntryPresence(scope(target)),
        sessionStoreLane,
      );
      assert.equal(present, true);
    }
    const page = await readSessionHistoryPageInWorker({
      kind: "history-event-page",
      params: {
        target: scope(targets[0]),
        options: { maxMessages: 20, offset: 40, maxBytes: 262144 },
      },
    });
    assert.equal(page.events.length, 20);
    const hash = sha256(JSON.stringify(page));
    expected ??= hash;
    assert.equal(hash, expected);
  });
const keepAlive = setInterval(() => {}, 1000);
const inspector = values.allocations ? new Session() : undefined;
try {
  const cold = performance.now();
  await read();
  const coldMs = performance.now() - cold;
  for (let i = 0; i < 10; i++) {
    await read();
  }
  closures = 0;
  cleanupMs = 0;
  charges.length = 0;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const latency = [],
    hostLoad = loadavg(),
    cpu = process.cpuUsage(),
    main = process.threadCpuUsage();
  for (let i = 0; i < iterations; i++) {
    const at = performance.now();
    await read();
    latency.push(performance.now() - at);
  }
  const usedCpu = process.cpuUsage(cpu),
    usedMain = process.threadCpuUsage(main);
  let sampledBytes;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = 0;
    fs.writeFileSync(`${values.output}.heapprofile`, JSON.stringify(profile));
    const visit = (node) => {
      sampledBytes += node.selfSize;
      node.children.forEach(visit);
    };
    visit(profile.head);
  }
  const sorted = latency.toSorted((a, b) => a - b);
  const measured = {
    closures,
    cleanupMs,
    chargesHash: sha256(JSON.stringify(charges)),
    charges: charges.slice(0, 5),
  };
  await rotateDatabaseWorkers(sessionStoreLane);
  await rotateDatabaseWorkers(historyLane);
  await read();
  fs.writeFileSync(
    values.output,
    JSON.stringify(
      {
        ownerHash,
        node: process.version,
        iterations,
        fixture:
          "5000 sessions, four stores, 100 messages per hot transcript; no workspace scan or 35GiB I/O stress",
        pageHash: expected,
        coldMs,
        p50Ms: sorted[Math.floor(iterations * 0.5)],
        p95Ms: sorted[Math.ceil(iterations * 0.95) - 1],
        cpuMs: (usedCpu.user + usedCpu.system) / 1000,
        mainCpuMs: (usedMain.user + usedMain.system) / 1000,
        sampledBytes,
        hostLoad,
        ...measured,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  inspector?.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  clearInterval(keepAlive);
}
