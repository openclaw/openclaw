// Synthetic, exact-source tool -> real Gateway WebSocket work-count reproduction.
// No model/provider calls. Baseline/candidate runs use fresh state directories:
// node --import ./scripts/tsx.mjs scripts/perf/session-search-rpc-measure.ts \
//   --state-dir <new-directory> --sessions 600 --visibility self [--tool-ref <base-sha>]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { AgentToolGatewayRequestCaller } from "../../src/agents/tools/in-process-gateway.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../src/daemon/constants.js";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { createGatewayBenchEnv, waitForInitialProbe } from "../lib/gateway-bench-runtime.ts";
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "600" },
    visibility: { type: "string", default: "all" },
    "tool-ref": { type: "string" },
  },
});
assert(values["state-dir"], "state-dir required and must be new");
assert(values.visibility === "all" || values.visibility === "self");
const visibility = values.visibility;
const toolRef = values["tool-ref"];
assert(toolRef === undefined || /^[a-f0-9]{40}$/.test(toolRef));
const toolUrl = new URL("../../src/agents/tools/sessions-search-tool.ts", import.meta.url);
const toolSource = toolRef
  ? execFileSync("git", ["show", toolRef + ":src/agents/tools/sessions-search-tool.ts"], {
      encoding: "utf8",
    })
  : readFileSync(toolUrl, "utf8");
const toolSourceHash = createHash("sha256").update(toolSource).digest("hex");
if (toolRef) {
  registerHooks({
    load(url, context, nextLoad) {
      return url === toolUrl.href
        ? { format: "module-typescript", source: toolSource, shortCircuit: true }
        : nextLoad(url, context);
    },
  });
}
const count = Number(values.sessions);
assert(Number.isSafeInteger(count) && count >= 400 && count <= 17000);
const root = path.resolve(values["state-dir"]);
mkdirSync(root, { mode: 0o700 });
for (const name of ["home", "workspace"]) {
  mkdirSync(path.join(root, name));
}
const port = await getFreePort();
const configPath = path.join(root, "openclaw.json");
const cfg: OpenClawConfig = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port,
    auth: { mode: "none" },
    controlUi: { enabled: false },
    tailscale: { mode: "off" },
  },
  discovery: { mdns: { mode: "off" } },
  browser: { enabled: false },
  plugins: { enabled: false },
  cron: { enabled: false },
  update: { checkOnStart: false },
  agents: {
    ownership: "explicit",
    entries: { main: { workspace: path.join(root, "workspace") } },
    defaults: { systemAgent: { agentId: "main" } },
  },
  session: { maintenance: { maxEntries: count * 2 } },
  tools: { sessions: { visibility }, agentToAgent: { enabled: true } },
  logging: { file: path.join(root, "gateway.log") },
};
writeFileSync(configPath, JSON.stringify(cfg));
const profile = "telemetry-search-proof-" + port;
const env: NodeJS.ProcessEnv = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_PROFILE: profile,
  OPENCLAW_LAUNCHD_LABEL: resolveGatewayLaunchAgentLabel(profile),
  OPENCLAW_SYSTEMD_UNIT: resolveGatewaySystemdServiceName(profile),
  OPENCLAW_WINDOWS_TASK_NAME: resolveGatewayWindowsTaskName(profile),
};
for (const key of ["TMPDIR", "TMP", "TEMP"]) {
  if (process.env[key] !== undefined) {
    env[key] = process.env[key];
  }
}
process.env = { ...env };
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(cfg);
const agent = await import("../../src/state/openclaw-agent-db.js");
const state = await import("../../src/state/openclaw-state-db.js");
const { seedTeamShapeSessions } = await import("./team-shape-sessions.ts");
try {
  await seedTeamShapeSessions({
    stateDir: root,
    sessions: count,
    retainedRuns: 0,
    seed: 967,
    now: Date.now(),
    transcriptBytes: 0,
    sessionKeys: ["agent:main:dashboard:telemetry-search-proof-requester"],
  });
} finally {
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}
const output = openSync(path.join(root, "gateway-output.log"), "wx", 0o600);
const child = spawn(
  "pnpm",
  [
    "dev",
    "gateway",
    "run",
    "--port",
    String(port),
    "--bind",
    "loopback",
    "--auth",
    "none",
    "--tailscale",
    "off",
    "--allow-unconfigured",
  ],
  { env, detached: true, stdio: ["ignore", output, output] },
);
writeFileSync(
  path.join(root, "owner.json"),
  JSON.stringify({
    driverPid: process.pid,
    gatewayLauncherPid: child.pid,
    head,
    port,
    stateDir: root,
    startedAt: new Date().toISOString(),
  }),
);
let cleanup: ReturnType<typeof stopChild> | undefined;
const stop = () => (cleanup ??= stopChild(child));
const interrupted = () => {
  void stop();
  process.exitCode = 1;
};
process.once("SIGTERM", interrupted);
process.once("SIGINT", interrupted);
const samples: Array<Record<string, unknown>> = [];
try {
  const started = performance.now();
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: started,
    deadlineAt: started + 120000,
    isDone: () => child.exitCode !== null || child.signalCode !== null,
  });
  assert.equal(ready.status, 200, "isolated Gateway did not become ready");
  const { callGateway } = await import("../../src/gateway/call.js");
  const { createSessionsSearchTool } =
    await import("../../src/agents/tools/sessions-search-tool.js");
  for (let sample = 0; sample < 6; sample++) {
    let listPages = 0,
      listRows = 0,
      searchCalls = 0,
      listMs = 0,
      searchMs = 0;
    const tool = createSessionsSearchTool({
      config: cfg,
      agentId: "main",
      agentSessionKey: "agent:main:dashboard:telemetry-search-proof-requester",
      callGateway: async <T>(request: Parameters<AgentToolGatewayRequestCaller>[0]): Promise<T> => {
        const before = performance.now();
        try {
          const result = await callGateway<T>({ ...request, config: cfg, timeoutMs: 90000 });
          if (request.method === "sessions.list") {
            listPages++;
            listRows += (result as { sessions: unknown[] }).sessions.length;
          }
          if (request.method === "sessions.search") {
            searchCalls++;
          }
          return result;
        } finally {
          if (request.method === "sessions.list") {
            listMs += performance.now() - before;
          }
          if (request.method === "sessions.search") {
            searchMs += performance.now() - before;
          }
        }
      },
    });
    const before = performance.now();
    const result = await tool.execute("synthetic-search-rpc", {
      query: "telemetrysearchproofnomatch",
      limit: 3,
    });
    const payload = result.details as {
      results?: unknown[];
      indexing?: boolean;
      warning?: string;
      truncated?: boolean;
      status?: string;
    };
    assert(Array.isArray(payload.results), "normal search did not return results");
    samples.push({
      sample,
      temperature: sample === 0 ? "cold" : "warm",
      elapsedMs: performance.now() - before,
      listPages,
      listRows,
      searchCalls,
      listMs,
      searchMs,
      resultCount: payload.results.length,
      indexing: payload.indexing === true,
      warning: typeof payload.warning === "string",
      truncated: payload.truncated === true,
    });
    writeFileSync(path.join(root, "samples.json"), JSON.stringify(samples, null, 2));
  }
  const result = {
    head,
    toolRef: toolRef ?? "working-tree",
    toolSourceHash,
    visibility,
    sessions: count,
    node: process.version,
    hostLoad: loadavg(),
    samples,
    scope:
      "Source-pinned tool -> real isolated Gateway WebSocket transport, synthetic no-match inventory; no real-model, full correctness or installed-path timing equivalence claim.",
  };
  writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  writeFileSync(
    path.join(root, "failure.json"),
    JSON.stringify({
      head,
      samples,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  throw error;
} finally {
  const outcome = await stop();
  writeFileSync(path.join(root, "teardown.json"), JSON.stringify(outcome));
  closeSync(output);
  process.off("SIGTERM", interrupted);
  process.off("SIGINT", interrupted);
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}
