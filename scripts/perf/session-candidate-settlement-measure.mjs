// Synthetic discovery + history-page reads through real workers. No operator state.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-candidate-settlement-measure.mjs \
//   --state /absolute/new-fixture --seed --output /absolute/result.json
// Repeat without --seed, alternating --owner-file frozen-baseline.ts and current source.
// Add --gateway for older chat.history pages over an isolated loopback WebSocket.
// Stable page-only reads can skip discovery; report that boundary, not a transport win.
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
    gateway: { type: "boolean" },
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
if (values.gateway) {
  process.env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      [
        "PATH",
        "LANG",
        "TMPDIR",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_HOME",
      ].includes(name),
    ),
  );
  Object.assign(process.env, {
    HOME: root,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  });
}
const env = {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  HOME: root,
};
const agentIds = ["main", "alpha", "beta", "gamma"];
const gatewayLog = path.join(root, "gateway.log");
const config = values.gateway
  ? {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(
          agentIds.map((agentId) => [
            agentId,
            { workspace: path.join(root, "workspace", agentId) },
          ]),
        ),
      },
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "none" },
        tailscale: { mode: "off" },
        controlUi: { enabled: false },
      },
      browser: { enabled: false },
      plugins: { enabled: false },
      cron: { enabled: false },
      session: { maintenance: { mode: "warn", coldStorage: { enabled: false } } },
      update: { checkOnStart: false },
      discovery: { mdns: { mode: "off" } },
      logging: { level: "info", consoleLevel: "silent", file: gatewayLog },
    }
  : { agents: { list: agentIds.map((id) => ({ id })) } };
if (values.gateway) {
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
}
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
const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
  await import("../../src/config/runtime-snapshot.ts");
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
const targets = agentIds.map((agentId) => ({
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
  const seededAt = Date.now();
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
          JSON.stringify({ sessionId: id, updatedAt: seededAt - i, status: "done" }),
          seededAt - i,
        );
        window.run(id, key, seededAt - i, seededAt - i, seededAt - i);
      }
    }, target);
    replaceTranscriptEventsSync(scope(target), [
      { type: "session", id: "synthetic-0", version: 3 },
      ...Array.from({ length: 100 }, (_, i) => ({
        type: "message",
        id: `message-${i}`,
        parentId: i ? `message-${i - 1}` : null,
        timestamp: new Date(seededAt - 100 + i).toISOString(),
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
const chargeOperations = [];
let closures = 0;
let cleanupMs = 0;
for (const lane of values.gateway ? [historyLane, sessionStoreLane] : [sessionStoreLane]) {
  const run = lane.pool.run.bind(lane.pool);
  lane.pool.run = (prepare, options) => {
    charges.push(options.inputBytes);
    if (values.gateway) {
      const charge = { operation: options.diagnosticOperation, bytes: options.inputBytes };
      chargeOperations.push(charge);
      return run(() => {
        const input = prepare();
        charge.operation = input.kind;
        return input;
      }, options);
    }
    return run(prepare, options);
  };
  const close = lane.pool.closeResources.bind(lane.pool);
  lane.pool.closeResources = async (...args) => {
    closures++;
    const at = performance.now();
    try {
      return await close(...args);
    } finally {
      cleanupMs += performance.now() - at;
    }
  };
}
let expected;
let read = () =>
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
let gateway;
let client;
let settleMs = 0;
const logStart = fs.existsSync(gatewayLog) ? fs.statSync(gatewayLog).size : 0;
try {
  if (values.gateway) {
    const { getFreePort } = await import("../lib/gateway-bench-probes.ts");
    const { createGatewayWsClient } = await import("../lib/gateway-ws-client.ts");
    const { PROTOCOL_VERSION } = await import("../../packages/gateway-protocol/src/version.ts");
    const port = await getFreePort();
    clearRuntimeConfigSnapshot();
    const { ensureCanonicalGatewayOwnerProfile } =
      await import("../../src/state/user-profile-writes.ts");
    await ensureCanonicalGatewayOwnerProfile("Synthetic history operator", { env: process.env });
    const { startGatewayServer } = await import("../../src/gateway/server.ts");
    gateway = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
    await gateway.startupSettled;
    client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    await client.waitOpen();
    const connected = await client.request("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.admin"],
      caps: [],
    });
    assert.equal(connected.ok, true, JSON.stringify(connected.error));
    read = async () => {
      const response = await client.request(
        "chat.history",
        {
          sessionKey: scope(targets[0]).sessionKey,
          limit: 20,
          offset: 40,
          maxBytes: 262144,
        },
        60000,
      );
      assert.equal(response.ok, true, JSON.stringify(response.error));
      assert.equal(response.payload.messages.length, 20);
      const hash = sha256(JSON.stringify(response.payload.messages));
      expected ??= hash;
      assert.equal(hash, expected);
    };
  }
  // Keep the post-ready idle interval and join paced facts backfill on every store.
  if (values.gateway) {
    const settling = performance.now();
    while (true) {
      const log = fs.readFileSync(gatewayLog).subarray(logStart).toString();
      if (
        performance.now() - settling >= 10000 &&
        log
          .split("\n")
          .filter((line) => line.includes("session: transcript facts backfill pass complete"))
          .length >= targets.length
      ) {
        break;
      }
      assert(
        performance.now() - settling < 180000,
        "Synthetic transcript facts backfill did not complete",
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
    settleMs = performance.now() - settling;
  }
  // Cold history-worker latency after store startup settles, not immediate-ready availability.
  const cold = performance.now();
  await read();
  const coldMs = performance.now() - cold;
  if (values.gateway) {
    const settling = performance.now();
    // Recovery awaits filesystem checks after its 30-second tick; join the real notification.
    const { observeOwnedDirectory } =
      await import("../../src/infra/owned-directory-observation.ts");
    await new Promise((resolve, reject) => {
      const observation = observeOwnedDirectory(
        path.dirname(targets[0].path),
        (filename, event) => {
          if (filename === undefined && event === undefined) {
            clearTimeout(deadline);
            observation.close();
            resolve();
          }
        },
      );
      const deadline = setTimeout(() => {
        observation.close();
        reject(new Error("Synthetic path recovery did not complete"));
      }, 60000);
    });
    await read();
    settleMs += performance.now() - settling;
  }
  for (let i = 0; i < 10; i++) {
    await read();
  }
  closures = 0;
  cleanupMs = 0;
  charges.length = 0;
  chargeOperations.length = 0;
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
    ...(values.gateway ? { chargeOperations: [...chargeOperations] } : {}),
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
        transport: values.gateway ? "loopback WebSocket chat.history" : "worker owner",
        settleMs,
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
  client?.close();
  await gateway?.close({ reason: "Synthetic history benchmark complete", exitAfterClose: true });
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  clearInterval(keepAlive);
}
