// Synthetic CLI/config-read benchmark; never point --state-dir at operator state.
// Prepare once (new directory only):
//   node --import ./scripts/tsx.mjs scripts/perf/config-validate-measure.mjs --state-dir .local/config-bench --setup --payload-mib 1024
// Then, from each built checkout, alternate fresh CLI runs against the same fixture:
//   node --import ./scripts/tsx.mjs scripts/perf/config-validate-measure.mjs --state-dir .local/config-bench --samples 5
// --profile adds separate Node CPU profiles; use unprofiled runs for timing decisions.
// The temporary Gateway uses a separate config, disables channels/plugins, and owns port 41810.
// Acceptance: identical valid results, fewer copied bytes, lower paired elapsed/CPU cost;
// GC and event-loop tails include sample counts and are interpreted using campaign controls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const metricsDirectory = process.env.OPENCLAW_CONFIG_BENCH_METRICS;
if (metricsDirectory) {
  // V8 metrics cover processes inheriting this preload; time(1) measures aggregate CPU.
  const { writeFileSync } = await import("node:fs");
  const pauses = [];
  const observer = new PerformanceObserver((list) => pauses.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  process.on("exit", () => {
    pauses.push(...observer.takeRecords());
    const cpu = process.cpuUsage();
    writeFileSync(
      path.join(metricsDirectory, `${process.pid}.json`),
      JSON.stringify({
        cpuMs: (cpu.user + cpu.system) / 1000,
        gcMs: pauses.reduce((sum, entry) => sum + entry.duration, 0),
        gcCount: pauses.length,
        gcMaxMs: Math.max(0, ...pauses.map((entry) => entry.duration)),
        gcByKind: Object.fromEntries(
          [1, 2, 4, 8].map((kind) => [
            kind,
            {
              count: pauses.filter((entry) => entry.detail.kind === kind).length,
              ms: pauses
                .filter((entry) => entry.detail.kind === kind)
                .reduce((sum, entry) => sum + entry.duration, 0),
            },
          ]),
        ),
        loopSamples: loop.count,
        loopP95Ms: loop.percentile(95) / 1e6,
        loopP99Ms: loop.percentile(99) / 1e6,
        loopMaxMs: loop.max / 1e6,
        maxRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  });
} else {
  await main();
}

async function main() {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      setup: { type: "boolean" },
      "payload-mib": { type: "string", default: "256" },
      samples: { type: "string", default: "5" },
      profile: { type: "boolean" },
    },
  });
  assert.ok(values["state-dir"], "--state-dir is required");
  const stateDir = path.resolve(values["state-dir"]);
  const self = fileURLToPath(import.meta.url);
  const configPath = path.join(stateDir, "openclaw.json");
  const { createGatewayBenchEnv } = await import("../lib/gateway-bench-runtime.ts");
  const env = {
    ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: true }),
    OPENCLAW_STATE_DIR: stateDir,
    TMPDIR: path.join(stateDir, "tmp"),
    OPENCLAW_PROFILE: "config-perf-41810",
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.config-perf-41810",
    OPENCLAW_SYSTEMD_UNIT: "openclaw-config-perf-41810",
    OPENCLAW_SKIP_CHANNELS: "1",
  };
  if (values.setup) {
    const payloadMiB = Number(values["payload-mib"]);
    assert.ok(Number.isSafeInteger(payloadMiB) && payloadMiB >= 0 && payloadMiB <= 4096);
    const { generateTeamShapeFixture, parseTeamShapeOptions } =
      await import("./team-shape-fixture.ts");
    await generateTeamShapeFixture(
      parseTeamShapeOptions([
        "--state-dir",
        stateDir,
        "--sessions",
        "10000",
        "--runs",
        "6000",
        "--settled-runs",
        "--transcript-mib",
        "0",
        "--projects",
        "0",
        "--port",
        "41810",
      ]),
    );
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const entries = [];
    for (const entry of (await readdir("extensions", { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = entry.name;
      let manifest;
      try {
        manifest = JSON.parse(
          await readFile(path.join("extensions", directory, "openclaw.plugin.json"), "utf8"),
        );
      } catch (error) {
        if (error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (!manifest.configSchema?.required?.length) {
        entries.push([manifest.id, { enabled: true, config: {} }]);
      }
      if (entries.length === 35) {
        break;
      }
    }
    config.plugins = { entries: Object.fromEntries(entries) };
    config.channels = Object.fromEntries(
      ["discord", "slack", "telegram", "signal", "whatsapp"].map((id) => [id, { enabled: false }]),
    );
    config.agents.ownership = "explicit";
    for (let i = 1; i < 3; i++) {
      config.agents.entries[`agent${i}`] = { workspace: path.join(stateDir, `workspace${i}`) };
    }
    config.models = {
      providers: Object.fromEntries(
        [0, 1].map((i) => [
          `synthetic${i}`,
          {
            baseUrl: "http://127.0.0.1:41811/v1",
            api: "openai-completions",
            models: Array.from({ length: i === 0 ? 5 : 0 }, (_, j) => ({
              id: `model${j}`,
              name: `Synthetic ${j}`,
            })),
          },
        ]),
      ),
    };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    const gatewayConfig = {
      ...config,
      plugins: { enabled: false },
      gateway: { ...config.gateway, reload: { mode: "off" } },
    };
    await writeFile(
      path.join(stateDir, "gateway-config.json"),
      JSON.stringify(gatewayConfig, null, 2),
    );
    const previous = process.env;
    try {
      process.env = env;
      const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
        await import("../../src/state/openclaw-state-db.ts");
      const { writeConfigMachineStateAsync } =
        await import("../../src/state/config-machine-state-async.ts");
      const database = openOpenClawStateDatabase({ env });
      try {
        const padding = "x".repeat(1024 * 1024);
        for (let i = 0; i < payloadMiB; i++) {
          await writeConfigMachineStateAsync(`perf.synthetic.${i}`, { padding }, { env });
        }
        database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        await closeOpenClawStateDatabaseAsync();
      }
    } finally {
      process.env = previous;
    }
    console.log(JSON.stringify({ stateDir, payloadMiB, agents: 3, plugins: 35, sessions: 10000 }));
    return;
  }
  assert.ok(
    (await readFile(path.join(stateDir, "team-shape-summary.json"), "utf8")).includes(
      "openclaw-team-shape-v1",
    ),
  );
  const samples = Number(values.samples);
  assert.ok(Number.isSafeInteger(samples) && samples > 0 && samples <= 100);
  const output = path.join(stateDir, `measurement-${Date.now()}`);
  await mkdir(output);
  const gateway = spawn(
    process.execPath,
    ["dist/entry.js", "gateway", "run", "--bind", "loopback", "--port", "41810"],
    {
      env: { ...env, OPENCLAW_CONFIG_PATH: path.join(stateDir, "gateway-config.json") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let gatewayLog = "";
  const exited = new Promise((resolve) => {
    gateway.once("close", resolve);
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Synthetic Gateway did not become ready")),
        60000,
      );
      const receive = (chunk) => {
        gatewayLog += chunk;
        if (gatewayLog.includes("http server listening")) {
          clearTimeout(timer);
          resolve();
        }
      };
      gateway.stdout.on("data", receive);
      gateway.stderr.on("data", receive);
      gateway.once("error", reject);
      gateway.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Gateway exited ${code}`));
      });
    });
    for (let sample = 0; sample < samples; sample++) {
      const metrics = path.join(output, String(sample));
      await mkdir(metrics);
      const args = [
        "--import",
        self,
        ...(values.profile ? ["--cpu-prof", `--cpu-prof-dir=${metrics}`] : []),
        "dist/entry.js",
        "config",
        "validate",
        "--json",
      ];
      const start = performance.now();
      const result = await new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/time", ["-p", process.execPath, ...args], {
          env: { ...env, OPENCLAW_CONFIG_BENCH_METRICS: metrics },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120000,
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
      const elapsedMs = performance.now() - start;
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).valid, true);
      const userSeconds = Number(/^user\s+(\S+)/m.exec(result.stderr)?.[1]);
      const systemSeconds = Number(/^sys\s+(\S+)/m.exec(result.stderr)?.[1]);
      assert.ok(Number.isFinite(userSeconds + systemSeconds), result.stderr);
      const processes = await Promise.all(
        (await readdir(metrics))
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => JSON.parse(await readFile(path.join(metrics, name), "utf8"))),
      );
      console.log(
        JSON.stringify({
          sample,
          elapsedMs,
          totalCpuMs: (userSeconds + systemSeconds) * 1000,
          load: loadavg(),
          processes,
          output,
        }),
      );
    }
  } finally {
    gateway.kill("SIGTERM");
    await exited;
    await writeFile(path.join(output, "gateway.log"), gatewayLog);
  }
}
