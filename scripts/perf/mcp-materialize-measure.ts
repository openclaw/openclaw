// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/mcp-materialize-measure.ts
//   --root <checkout> --workspace <synthetic-workspace> --mode hung [--cold] [--profile <dir>]
// Run baseline/candidate alternately, >=5 pairs; profile separately from timing.
// First create a 5,000-session team-shape-fixture.ts, then --pad-fixture <state-dir>
// adds synthetic SQLite ballast and a 62,000-file workspace (never production state).
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { json } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { BundleMcpToolRuntime } from "../../src/agents/agent-bundle-mcp-types.js";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    workspace: { type: "string" },
    mode: { type: "string", default: "hung" },
    cold: { type: "boolean", default: false },
    profile: { type: "string" },
    "pad-fixture": { type: "string" },
  },
});
if (values["pad-fixture"]) {
  const fixture = path.resolve(values["pad-fixture"]);
  // Only a canonical synthetic fixture may receive the additive ballast table.
  await readFile(path.join(fixture, "team-shape-summary.json"));
  const databasePath = path.join(fixture, "agents/main/agent/openclaw-agent.sqlite");
  const initialBytes = (await stat(databasePath)).size;
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE synthetic_mcp_materialize_padding (payload BLOB NOT NULL)");
    const insert = database.prepare(
      "INSERT INTO synthetic_mcp_materialize_padding VALUES (zeroblob(1048576))",
    );
    const chunks = Math.max(0, Math.ceil((35 * 1024 ** 3 - initialBytes) / 1024 ** 2));
    for (let offset = 0; offset < chunks; offset += 256) {
      database.exec("BEGIN");
      for (let index = offset; index < Math.min(chunks, offset + 256); index++) {
        insert.run();
      }
      database.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    }
  } finally {
    database.close();
  }
  const workspace = path.join(fixture, "mcp-workspace");
  await mkdir(workspace);
  const content = Buffer.alloc(18_432, "synthetic workspace text\n");
  for (let index = 0; index < 62_000; index++) {
    const directory = path.join(workspace, `directory-${Math.floor(index / 1_000)}`);
    if (index % 1_000 === 0) {
      await mkdir(directory);
    }
    await writeFile(path.join(directory, `file-${index}.txt`), content);
  }
  console.log(
    JSON.stringify({
      fixture,
      databaseBytes: (await stat(databasePath)).size,
      workspace,
      files: 62_000,
      workspaceBytes: 62_000 * content.length,
    }),
  );
  process.exit(0);
}
assert(values.workspace, "--workspace must name synthetic state");
assert(["healthy", "slow", "hung"].includes(values.mode));
const source = (file: string) => pathToFileURL(path.resolve(values.root, file)).href;
const { createSessionMcpRuntimeManager } = await import(
  source("src/agents/agent-bundle-mcp-manager.ts")
);
const { materializeBundleMcpToolsForRun } = await import(
  source("src/agents/agent-bundle-mcp-materialize.ts")
);
const { GatewayScheduler } = await import(source("src/infra/gateway-scheduler.ts"));
const scheduler = new GatewayScheduler();
const manager = createSessionMcpRuntimeManager({ scheduler });
let mode = "healthy";
let lists = 0;
let initializes = 0;
const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== "POST") {
      res.writeHead(req.method === "DELETE" ? 204 : 405).end();
      return;
    }
    const msg = (await json(req)) as {
      id?: number | string;
      method: string;
      params?: { protocolVersion?: string };
    };
    let result: unknown;
    if (msg.method === "initialize") {
      initializes++;
      result = {
        protocolVersion: msg.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic-catalog", version: "1" },
      };
    } else if (msg.method === "tools/list") {
      lists++;
      if (mode === "hung") {
        return;
      }
      if (mode === "slow") {
        await delay(3_000);
      }
      result = {
        tools: [
          { name: "probe", description: "Read a synthetic fact.", inputSchema: { type: "object" } },
        ],
      };
    } else {
      res.writeHead(202).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  })().catch(() => res.writeHead(500).end());
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");
const params = {
  workspaceDir: values.workspace,
  agentDir: path.join(values.workspace, "agent"),
  manifestRegistry: { plugins: [] },
  cfg: {
    plugins: { enabled: false },
    mcp: {
      servers: {
        fixture: { transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp` },
      },
    },
  },
};
const bytes = (prepared: BundleMcpToolRuntime) =>
  JSON.stringify(
    prepared.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  );
let inspector: Session | undefined;
try {
  // Imports/transport initialization are warm on both arms, even in the cold-identity probe.
  const seed = await materializeBundleMcpToolsForRun(
    await manager.acquire({ ...params, sessionId: "seed" }),
  );
  const initialBytes = bytes(seed);
  await seed.dispose();
  await delay(2);
  mode = values.mode;
  lists = 0;
  initializes = 0;
  global.gc?.();
  if (values.profile) {
    await mkdir(values.profile, { recursive: true });
    inspector = new Session();
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const cpu = process.cpuUsage();
  const startedAt = Date.now();
  const start = performance.now();
  const acquired = await manager.acquire({
    ...params,
    sessionId: "first-send",
    ...(values.cold ? { agentDir: path.join(values.workspace, "first-ever-principal") } : {}),
  });
  const pending = materializeBundleMcpToolsForRun(acquired);
  // Observe completion on both arms, including time relocated to background refresh.
  const complete = (async () => {
    const deadline = performance.now() + 15_000;
    while (
      !acquired.runtime.peekCatalog() ||
      (mode === "hung"
        ? !acquired.runtime.peekCatalog().diagnostics?.length
        : lists === 0 || acquired.runtime.peekCatalog().generatedAt < startedAt)
    ) {
      assert(performance.now() < deadline, "catalog refresh never settled");
      await delay(25);
    }
  })();
  const prepared = await pending;
  const foregroundCpu = process.cpuUsage(cpu);
  const foregroundMs = performance.now() - start;
  const foregroundAllocations = inspector
    ? await inspector.post("HeapProfiler.getSamplingProfile")
    : undefined;
  const knownTools = bytes(prepared) === initialBytes;
  if (mode !== "hung") {
    assert(knownTools, "unchanged catalog bytes drifted");
  }
  if (values.cold && mode === "hung") {
    assert.equal(prepared.tools.length, 0);
    assert.match(prepared.diagnostics?.[0]?.message ?? "", /timed out after 10000ms/);
  }
  await complete;
  const totalCpu = process.cpuUsage(cpu);
  const totalMs = performance.now() - start;
  assert.equal(lists, 1);
  assert.equal(initializes, 1);
  if (inspector) {
    const allocations = await inspector.post("HeapProfiler.stopSampling");
    const profile = await inspector.post("Profiler.stop");
    await writeFile(
      path.join(values.profile!, "foreground.heapprofile"),
      JSON.stringify(foregroundAllocations),
    );
    await writeFile(path.join(values.profile!, "total.heapprofile"), JSON.stringify(allocations));
    await writeFile(
      path.join(values.profile!, "total.cpuprofile"),
      JSON.stringify(profile.profile),
    );
  }
  console.log(
    JSON.stringify({
      mode,
      cold: values.cold,
      traced: Boolean(inspector),
      foregroundMs,
      totalMs,
      foregroundCpuMs: (foregroundCpu.user + foregroundCpu.system) / 1000,
      totalCpuMs: (totalCpu.user + totalCpu.system) / 1000,
      knownTools,
      lists,
      initializes,
      diagnostics: prepared.diagnostics ?? [],
    }),
  );
  await prepared.dispose();
} finally {
  inspector?.disconnect();
  await manager.disposeAll();
  await scheduler.stop();
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}
