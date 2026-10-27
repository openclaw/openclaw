/**
 * Overlapping restarts on an existing synthetic teamBoot fixture (never production):
 * node --import ./scripts/tsx.mjs scripts/perf/config-health-restart-measure.ts \
 *   --entry /built/revision/dist/entry.js --fixture-root .local/team-boot \
 *   --runs 5 --output .local/restarts.json
 * Seed with bench-gateway-startup.ts --case teamBoot --fixture-root ... --seed-only.
 * Keep the predecessor serving until the successor completes environment selection,
 * then pause the successor itself until predecessor shutdown completes. Report both
 * full wall time and time excluding that imposed pause, not production downtime.
 * Config health reads therefore encounter a real live owner. Alternate built revisions on
 * equivalent fixtures; this script never rewrites config or recovery backups.
 * CPU covers the process tree still alive at admission, RSS the Gateway process;
 * neither is main-thread allocation. Raw traces retain server phase/heap measurements.
 * State checks ignore health observation and plugin-index generation timestamps,
 * retaining all other health/plugin facts from the predecessor after its normal
 * plugin-registry maintenance through successor restart, outside measured startup.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { delay, stopChild } from "../lib/gateway-bench-child.ts";
import {
  getFreePort,
  readProcessTreeCpuMs,
  startGatewayRssSampling,
} from "../lib/gateway-bench-probes.ts";
import {
  buildGatewayBenchChildArgs,
  collectOutputLines,
  collectTraceLine,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    entry: { type: "string" },
    "fixture-root": { type: "string" },
    output: { type: "string" },
    runs: { type: "string", default: "5" },
  },
});
assert(
  values.entry && values["fixture-root"] && values.output,
  "Provide --entry, --fixture-root and --output",
);
const entry = path.resolve(values.entry);
const root = path.resolve(values["fixture-root"]);
const configPath = path.join(root, "openclaw.json");
const runs = parseStrictIntegerOption({ raw: values.runs, fallback: 5, min: 1, label: "runs" });
assert(statSync(entry).isFile(), "Built entry is not a file");
assert(
  statSync(path.join(root, "team-boot-fixture.json")).isFile(),
  "Expected a seeded teamBoot fixture",
);
const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
assert(config && typeof config === "object" && "gateway" in config);
const gateway = config.gateway;
assert(gateway && typeof gateway === "object" && "auth" in gateway);
const auth = gateway.auth;
assert(auth && typeof auth === "object" && "token" in auth && typeof auth.token === "string");
const authToken = auth.token;
const env = createGatewayBenchEnv(root, configPath, { caseEnv: { OPENCLAW_SKIP_CHANNELS: "1" } });
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const configBefore = hash(configPath);
const backupBefore = hash(`${configPath}.bak`);
const timeoutMs = 180_000;
assert(
  process.platform === "darwin" || process.platform === "linux",
  "Restart gate requires POSIX signals",
);
const controlDir = mkdtempSync(path.join(root, "restart-control-"));
const preload = path.join(controlDir, "pause-after-environment.mjs");
const pauseMarker = "CONFIG_HEALTH_RESTART_PAUSED";
writeFileSync(
  preload,
  `
import { isMainThread } from "node:worker_threads";
if (isMainThread) {
  let armed = true;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    let carry = "";
    stream.write = function(chunk, ...args) {
      const result = write.call(this, chunk, ...args);
      carry = (carry + String(chunk)).slice(-2048);
      if (armed && /\\[gateway\\] startup trace: cli\\.main\\.gateway-run-select-environment [\\d.]+ms total=/u.test(carry)) {
        armed = false;
        write.call(this, "${pauseMarker}\\n");
        process.kill(process.pid, "SIGSTOP");
      }
      return result;
    };
  }
}
`,
);

async function stateFingerprint() {
  const { readConfigHealthStateFromStore } = await import("../../src/config/io.health-state.js");
  const { readPersistedInstalledPluginIndexSync } =
    await import("../../src/plugins/installed-plugin-index-store.js");
  const { createPluginCache, withPluginCache } = await import("../../src/plugins/plugin-cache.js");
  const { withArtifactPreservingStateReads } =
    await import("../../src/state/artifact-preserving-state-reads.js");
  const { closeOpenClawStateDatabaseAsync } =
    await import("../../src/state/openclaw-state-db-cache.js");
  try {
    const health = withArtifactPreservingStateReads(() =>
      readConfigHealthStateFromStore({ env, homedir: () => root, logger: console }),
    );
    assert(health.entries?.[configPath]?.lastKnownGood, "Fixture lacks known-good config health");
    const healthHash = createHash("sha256")
      .update(
        JSON.stringify(health, (key, value: unknown) => (key === "observedAt" ? undefined : value)),
      )
      .digest("hex");
    // Each inspection follows external Gateway writes, outside this process's cache lifecycle.
    await using cache = createPluginCache();
    const index = withPluginCache(cache, () =>
      withArtifactPreservingStateReads(() => readPersistedInstalledPluginIndexSync({ env })),
    );
    assert(index, "Fixture lacks persisted plugin metadata");
    const { generatedAtMs: _generatedAtMs, ...pluginMetadata } = index;
    return {
      health: healthHash,
      plugins: createHash("sha256").update(JSON.stringify(pluginMetadata)).digest("hex"),
    };
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
}

async function freePort() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = await getFreePort();
    if (port >= 40000) {
      return port;
    }
  }
  throw new Error("Could not allocate a loopback port >=40000");
}

function launch(port: number, onLine?: (line: string) => void, nodeOptions: string[] = []) {
  const startAt = performance.now();
  const child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(entry, port, nodeOptions, "token"),
    {
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const startupTrace: Record<string, number> = {};
  const startupTraceLines: string[] = [];
  const outputTail: string[] = [];
  const sampler = startGatewayRssSampling(child);
  const cpuStartMs = readProcessTreeCpuMs(child.pid);
  let error: Error | undefined;
  child.once("error", (cause) => {
    error = cause;
  });
  for (const stream of [child.stdout, child.stderr]) {
    let carry = "";
    stream.on("data", (chunk: Buffer) => {
      const parsed = collectOutputLines(carry, chunk.toString("utf8"));
      carry = parsed.carry;
      for (const line of parsed.lines) {
        if (collectTraceLine(line, "startup trace", startupTrace)) {
          startupTraceLines.push(line);
        }
        outputTail.push(line);
        if (outputTail.length > 40) {
          outputTail.shift();
        }
        onLine?.(line);
      }
    });
  }
  let stopping: ReturnType<typeof stopChild> | undefined;
  return {
    child,
    port,
    startAt,
    startupTrace,
    startupTraceLines,
    outputTail,
    deadlineAt: startAt + timeoutMs,
    isDone: () => error !== undefined || child.exitCode !== null || child.signalCode !== null,
    metrics() {
      const cpuEndMs = readProcessTreeCpuMs(child.pid);
      return {
        cpuMs: cpuStartMs === null || cpuEndMs === null ? null : cpuEndMs - cpuStartMs,
        maxRssMb: sampler.sample(),
        hostLoad: loadavg(),
      };
    },
    stop() {
      sampler.stop();
      return (stopping ??= stopChild(child, { teardownGraceMs: 30_000, killGraceMs: 2_000 }));
    },
  };
}
type Gateway = ReturnType<typeof launch>;

async function sessionAdmission(server: Gateway) {
  let lastError = "No connection attempted";
  let attempts = 0;
  while (performance.now() < server.deadlineAt && !server.isDone()) {
    attempts++;
    const remaining = () => Math.max(1, server.deadlineAt - performance.now());
    const client = createGatewayWsClient({
      url: `ws://127.0.0.1:${server.port}`,
      openTimeoutMs: Math.min(1000, remaining()),
      handshakeTimeoutMs: remaining(),
    });
    try {
      await client.waitOpen();
      const connected = await client.request(
        "connect",
        {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "gateway-client",
            displayName: "restart-benchmark",
            version: "1.0.0",
            platform: process.platform,
            mode: "backend",
          },
          role: "operator",
          auth: { token: authToken },
          scopes: ["operator.read"],
          caps: [],
        },
        remaining(),
      );
      assert(connected.ok, `connect: ${JSON.stringify(connected.error)}`);
      const response = await client.request(
        "sessions.list",
        {
          limit: 1,
          agentId: "incident-agent-01",
          label: "Synthetic startup session 0",
        },
        remaining(),
      );
      assert(response.ok, `sessions.list: ${JSON.stringify(response.error)}`);
      const payload = response.payload;
      assert(
        payload &&
          typeof payload === "object" &&
          "sessions" in payload &&
          Array.isArray(payload.sessions),
      );
      assert(
        payload.sessions.some(
          (session: unknown) =>
            session &&
            typeof session === "object" &&
            "key" in session &&
            session.key === "agent:incident-agent-01:bench-0",
        ),
        "Seeded session is missing",
      );
      return { ms: performance.now() - server.startAt, attempts };
    } catch (error) {
      lastError = String(error);
    } finally {
      client.ws.terminate();
    }
    await delay(25);
  }
  throw new Error(`Client admission failed: ${lastError}\n${server.outputTail.join("\n")}`);
}

async function ready(server: Gateway) {
  const [probe, admission] = await Promise.all([
    waitForInitialProbe({ ...server, path: "/readyz" }),
    sessionAdmission(server),
  ]);
  assert.equal(probe.status, 200, "Gateway never became ready");
  return { readyzMs: probe.ms, admission, ...server.metrics() };
}

async function runIteration(index: number) {
  const hostLoadBefore = loadavg();
  const predecessor = launch(await freePort());
  let successor: Gateway | undefined;
  let handoff: ReturnType<Gateway["stop"]> | undefined;
  let handoffMs: number | undefined;
  let imposedPauseMs = 0;
  let predecessorShutdownMs = 0;
  try {
    const predecessorReady = await ready(predecessor);
    while (
      predecessor.startupTrace["startup.maintenance.plugin-registry"] === undefined &&
      performance.now() < predecessor.deadlineAt &&
      !predecessor.isDone()
    ) {
      await delay(50);
    }
    assert(
      predecessor.startupTrace["startup.maintenance.plugin-registry"] !== undefined,
      `Predecessor plugin-registry maintenance did not finish:\n${predecessor.outputTail.join("\n")}`,
    );
    const stateBefore = await stateFingerprint();
    successor = launch(
      await freePort(),
      (line) => {
        if (!handoff && line === pauseMarker) {
          const pausedAt = performance.now();
          handoffMs = performance.now() - successor!.startAt;
          handoff = (async () => {
            try {
              const exit = await predecessor.stop();
              predecessorShutdownMs = performance.now() - pausedAt;
              return exit;
            } finally {
              imposedPauseMs = performance.now() - pausedAt;
              successor!.child.kill("SIGCONT");
            }
          })();
          void handoff.catch(() => {});
        }
      },
      ["--import", preload],
    );
    const successorReady = await ready(successor);
    assert(handoff, "Successor did not emit environment-selection completion");
    const predecessorExit = await handoff;
    const successorExit = await successor.stop();
    assert.equal(predecessorExit.exitCode, 0, "Predecessor shutdown was not clean");
    assert.equal(successorExit.exitCode, 0, "Successor shutdown was not clean");
    assert.equal(hash(configPath), configBefore, "Restart changed config bytes");
    assert.equal(hash(`${configPath}.bak`), backupBefore, "Restart changed backup bytes");
    const stateAfter = await stateFingerprint();
    assert.deepEqual(stateAfter, stateBefore, "Restart changed semantic health or plugin facts");
    return {
      index,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      predecessorReady,
      successorReady,
      handoffMs,
      imposedPauseMs,
      predecessorShutdownMs,
      activeStartupMs: successorReady.admission.ms - imposedPauseMs,
      predecessorExit,
      successorExit,
      stateBefore,
      stateAfter,
      startupTrace: successor.startupTrace,
      startupTraceLines: successor.startupTraceLines,
    };
  } finally {
    await handoff?.catch(() => {});
    await Promise.all([predecessor.stop(), successor?.stop()]);
  }
}

const samples: Awaited<ReturnType<typeof runIteration>>[] = [];
try {
  for (let index = 0; index < runs; index++) {
    samples.push(await runIteration(index));
    console.log(
      `restart ${index + 1}/${runs}: admission=${samples.at(-1)?.successorReady.admission.ms.toFixed(1)}ms`,
    );
  }
} finally {
  rmSync(controlDir, { recursive: true });
  writeFileSync(
    path.resolve(values.output),
    `${JSON.stringify(
      {
        entry,
        root,
        node: process.version,
        configBefore,
        configAfter: hash(configPath),
        backupBefore,
        backupAfter: hash(`${configPath}.bak`),
        samples,
      },
      null,
      2,
    )}\n`,
  );
}
