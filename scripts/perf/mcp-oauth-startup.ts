/**
 * OAuth-denied MCP startup owner probe, using real loopback HTTP and native state.
 * Run separately on pinned base/candidate sources, timing then allocation:
 * node --import ./scripts/tsx.mjs scripts/perf/mcp-oauth-startup.ts \
 *   --output .local/mcp-oauth-base [--root <source-root>] [--allocation]
 * Defaults: 3,000 native acquisitions with distinct capability contexts, 40
 * enabled plugin metadata records and one OAuth server. --sessions shortens smoke
 * runs; --port defaults to loopback 45037. Each acquisition runs real transport,
 * OAuth and cleanup owners. These are startup-owner costs, NOT Gateway throughput
 * or latency under a 10-minute load campaign.
 * Acceptance: one initial 401 and warning, no repeated startup while credentials
 * are unchanged, denied native acquisition with a sign-in log, lower CPU/allocation.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { PluginManifestRegistry } from "../../src/plugins/manifest-registry.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    output: { type: "string" },
    sessions: { type: "string", default: "3000" },
    port: { type: "string", default: "45037" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values.output, "Pass a new isolated --output directory");
const root = path.resolve(values.root);
const output = path.resolve(values.output);
const sessions = parseStrictIntegerOption({
  raw: values.sessions,
  label: "sessions",
  min: 1,
  fallback: 3000,
});
const port = parseStrictIntegerOption({
  raw: values.port,
  label: "port",
  min: 40000,
  fallback: 45037,
});
assert(port <= 65535, "port must be <= 65535");
await mkdir(output);
const stateDir = path.join(output, "state");
await mkdir(stateDir);
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  OPENCLAW_HOME: path.join(output, "home"),
});
let initializes = 0;
const server = createServer((request, response) => {
  request.resume();
  if (request.method === "POST") {
    initializes++;
    response.writeHead(401).end();
  } else {
    response.writeHead(405).end();
  }
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string");
const manifestRegistry: PluginManifestRegistry = {
  plugins: Array.from({ length: 40 }, (_, index) => ({
    id: `synthetic-${index}`,
    format: "openclaw",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "config",
    rootDir: path.join(output, `plugin-${index}`),
    source: path.join(output, `plugin-${index}/index.js`),
    manifestPath: path.join(output, `plugin-${index}/openclaw.plugin.json`),
  })),
  diagnostics: [],
};
const cfg: OpenClawConfig = {
  plugins: {
    entries: Object.fromEntries(manifestRegistry.plugins.map(({ id }) => [id, { enabled: true }])),
  },
  mcp: {
    servers: {
      denied: {
        url: `http://127.0.0.1:${address.port}/mcp`,
        transport: "streamable-http",
        auth: "oauth",
      },
    },
  },
};
await writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
const sourceUrl = (relative: string) => pathToFileURL(path.join(root, relative)).href;
const { createSessionMcpRuntime } = (await import(
  sourceUrl("src/agents/agent-bundle-mcp-runtime.ts")
)) as typeof import("../../src/agents/agent-bundle-mcp-runtime.js");
const { acquireNativeMcpServer } = (await import(
  sourceUrl("src/agents/native-mcp-runtime.ts")
)) as typeof import("../../src/agents/native-mcp-runtime.js");
const { resetMcpStartupBackoff } = (await import(
  sourceUrl("src/agents/mcp-startup-backoff.ts")
)) as typeof import("../../src/agents/mcp-startup-backoff.js");
const database = (await import(
  sourceUrl("src/state/openclaw-state-db.ts")
)) as typeof import("../../src/state/openclaw-state-db.js");
const logging = (await import(
  sourceUrl("src/logging/logger.ts")
)) as typeof import("../../src/logging/logger.js");
const logPath = path.join(output, "startup.log");
logging.applyLoggingConfig({ level: "warn", consoleLevel: "silent", file: logPath });
const inspector = new Session();
let serial = 0;
const admissionMs: number[] = [];
const startup = async (measured: boolean) => {
  const start = performance.now();
  const runtime = createSessionMcpRuntime({
    sessionId: `synthetic-${serial++}`,
    workspaceDir: output,
    agentDir: path.join(stateDir, "agents/main/agent"),
    cfg,
    manifestRegistry,
  });
  try {
    await assert.rejects(
      acquireNativeMcpServer(runtime, "denied", {
        capabilityContext: {},
        capabilities: {},
        roots: { roots: [] },
        assertCurrent() {},
      }),
      /not connected/,
    );
    if (measured) {
      admissionMs.push(performance.now() - start);
    }
  } finally {
    await runtime.dispose();
    await runtime.joinCleanup?.();
  }
};
try {
  await startup(false);
  await logging.flushLogger();
  const warmupLog = await readFile(logPath, "utf8");
  assert.match(warmupLog, /requires OAuth authorization/);
  assert.match(warmupLog, /Sign in from Settings/);
  const coldInitializes = initializes;
  assert.equal(coldInitializes, 1, "Cold acquisition must reach the OAuth-required HTTP server");
  const hostLoadBefore = loadavg();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16_384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuStart = process.cpuUsage();
  const threadCpuStart = process.threadCpuUsage();
  const wallStart = performance.now();
  for (let index = 0; index < sessions; index++) {
    await startup(true);
  }
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  const threadCpu = process.threadCpuUsage(threadCpuStart);
  let sampledBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
    sampledBytes = bytes(profile.head);
  }
  await logging.flushLogger();
  const log = await readFile(logPath, "utf8");
  assert.match(log, /requires OAuth authorization/);
  assert.match(log, /Sign in from Settings/);
  admissionMs.sort((a, b) => a - b);
  const result = {
    sourceRoot: root,
    mode: values.allocation ? "allocation" : "timing",
    sessions,
    plugins: 40,
    oauthServers: 1,
    coldInitializes,
    repeatedInitializes: initializes - coldInitializes,
    startupWarnings: log.split("\n").filter((line) => line.includes("failed to start server"))
      .length,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
    cpuUsPerSession: (cpu.user + cpu.system) / sessions,
    sampledBytes,
    sampledBytesPerSession: sampledBytes === undefined ? undefined : sampledBytes / sessions,
    admissionP50Ms: admissionMs[Math.floor(sessions * 0.5)],
    admissionP95Ms: admissionMs[Math.floor(sessions * 0.95)],
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    memory: process.memoryUsage(),
  };
  await writeFile(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  resetMcpStartupBackoff();
  inspector.disconnect();
  await database.closeOpenClawStateDatabaseAsync();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
