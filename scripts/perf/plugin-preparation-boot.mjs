#!/usr/bin/env node
// Usage: node --import ./scripts/tsx.mjs scripts/perf/plugin-preparation-boot.mjs \
//   --entry /absolute/build/dist/entry.js --plugins /absolute/fixture.json --output /new/output
// Fixture: {"plugins":{"allow":["fixture-id"],"load":{"paths":["/owned/plugin"]}}}.
// Run serial AB/BA pairs with fresh output directories. No model/backend requests or forced GC.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stopGatewayGracefully } from "../lib/gateway-bench-child.ts";
import { readGatewayResources } from "../lib/gateway-bench-profile.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    entry: { type: "string" },
    plugins: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.entry || !path.isAbsolute(values.entry) || !values.plugins || !values.output) {
  throw new Error(
    "Require --entry <absolute built entry> --plugins <fixture.json> --output <new directory>",
  );
}
const entry = realpathSync(values.entry);
if (path.basename(path.dirname(entry)) !== "dist") {
  throw new Error("--entry must select a built dist entry");
}
const fragment = JSON.parse(readFileSync(values.plugins, "utf8"));
const expected = fragment.plugins?.allow;
if (
  !Array.isArray(expected) ||
  !expected.length ||
  expected.some((id) => typeof id !== "string") ||
  !Array.isArray(fragment.plugins?.load?.paths) ||
  !fragment.plugins.load.paths.length
) {
  throw new Error("Fixture must declare nonempty plugins.allow and plugins.load.paths");
}
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output, { mode: 0o700 });
const home = path.join(output, "home");
const tmp = path.join(output, "tmp");
mkdirSync(home);
mkdirSync(tmp);
const configPath = writeGatewayBenchConfig(
  home,
  {
    ...BASE_GATEWAY_BENCH_CONFIG,
    plugins: { ...BASE_GATEWAY_BENCH_CONFIG.plugins, ...fragment.plugins },
    cron: { enabled: false },
  },
  { agentList: [{ id: "main", workspace: path.join(home, "workspace") }] },
);

async function freePort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (port >= 40000) {
      return port;
    }
  }
  throw new Error("No loopback port >=40000 available");
}

function workerCounts(untilNs) {
  const byScript = {};
  for (const name of readdirSync(output).filter((file) => /^workers-\d+-\d+\.jsonl$/.test(file))) {
    for (const line of readFileSync(path.join(output, name), "utf8").trim().split("\n")) {
      if (!line) {
        continue;
      }
      const event = JSON.parse(line);
      if (untilNs && BigInt(event.atNs) > BigInt(untilNs)) {
        continue;
      }
      const count = (byScript[event.script] ??= { created: 0, exited: 0, alive: 0 });
      if (event.kind === "create") {
        count.created++;
        count.alive++;
      } else {
        count.exited++;
        count.alive--;
      }
    }
  }
  return {
    byScript,
    totals: Object.values(byScript).reduce(
      (sum, count) => ({
        created: sum.created + count.created,
        exited: sum.exited + count.exited,
        alive: sum.alive + count.alive,
      }),
      { created: 0, exited: 0, alive: 0 },
    ),
  };
}

function sampleBoot(child) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } else {
        resolve(value);
      }
    };
    const onMessage = (message) => {
      if (
        message?.channel === "openclaw.plugin-preparation-boot" &&
        message.snapshot?.pid === child.pid
      ) {
        finish(undefined, message.snapshot);
      }
    };
    const onExit = () => finish(new Error("Gateway exited before readiness accounting"));
    const timer = setTimeout(() => finish(new Error("Readiness accounting timed out")), 10_000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.send({ channel: "openclaw.plugin-preparation-boot", action: "sample" }, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}

const port = await freePort();
const stopPreload = new URL("../lib/gateway-bench-stop-preload.mjs", import.meta.url);
stopPreload.searchParams.set("parentPid", String(process.pid));
stopPreload.searchParams.set("entry", entry);
const preload = fileURLToPath(new URL("./plugin-preparation-boot-preload.mjs", import.meta.url));
const args = buildGatewayBenchChildArgs(entry, port, [
  "--import",
  fileURLToPath(new URL("./team-shape-stress-loader.mjs", import.meta.url)),
  "--import",
  preload,
  "--import",
  fileURLToPath(new URL("../lib/gateway-bench-profile-preload.ts", import.meta.url)),
  "--import",
  stopPreload.href,
]);
const env = createGatewayBenchEnv(home, configPath, {
  caseEnv: {
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_PLUGIN_BOOT_OUTPUT: output,
    // Foreground Gateway disables the main compile cache through execve; start
    // disabled so the benchmark's IPC descriptor survives the cold launch.
    NODE_DISABLE_COMPILE_CACHE: "1",
  },
});
const logPath = path.join(output, "gateway.log");
const fd = openSync(logPath, "wx", 0o600);
const startAt = performance.now();
const hostLoadStart = loadavg();
const child = spawn(process.execPath, args, {
  cwd: path.dirname(path.dirname(entry)),
  env,
  stdio: ["ignore", fd, fd, "ipc"],
});
let childError;
child.on("error", (error) => {
  childError = error;
});
const exited = new Promise((resolve) => {
  child.once("close", resolve);
});
const alive = () => child.exitCode === null && child.signalCode === null && !childError;
let forcedKill;
const stopOwnedChild = () => {
  if (alive()) {
    child.kill("SIGTERM");
  }
  forcedKill ??= setTimeout(() => {
    if (alive()) {
      child.kill("SIGKILL");
    }
  }, 2_000);
};
const watchdog = setTimeout(stopOwnedChild, 180_000);
process.once("SIGINT", stopOwnedChild);
process.once("SIGTERM", stopOwnedChild);
let result;
try {
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt,
    deadlineAt: startAt + 180_000,
    isDone: () => !alive(),
  });
  if (ready.status !== 200 || ready.ms === null) {
    throw (
      childError ??
      new Error("Gateway did not become ready within 180 seconds; inspect gateway.log")
    );
  }
  // Timing and cheap work counts precede the diagnostic worker census.
  const readiness = await sampleBoot(child);
  const workersAtReadiness = workerCounts(readiness.atNs);
  let loaded;
  for (let attempt = 0; attempt < 100; attempt++) {
    const match = /http server listening \(\d+ plugins?: ([^;\n]+);/.exec(
      readFileSync(logPath, "utf8"),
    );
    if (match) {
      loaded = match[1].split(", ");
      break;
    }
    await delay(25);
  }
  if (!loaded || expected.some((id) => !loaded.includes(id))) {
    throw new Error(
      `Ready Gateway did not report every expected plugin loaded: ${JSON.stringify({ expected, loaded })}`,
    );
  }
  let resources;
  for (let attempt = 0; attempt < 20; attempt++) {
    resources = await readGatewayResources(child, { includeWorkers: true, collectGarbage: false });
    if (!resources.workers?.workerMemoryMissing?.length) {
      break;
    }
    await delay(250);
  }
  const shutdown = await stopGatewayGracefully(child, 30_000);
  result = {
    format: "openclaw-plugin-preparation-boot-v1",
    entry,
    entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
    fixtureSha256: createHash("sha256").update(readFileSync(values.plugins)).digest("hex"),
    expectedPluginIds: expected,
    loadedPluginIds: loaded,
    ready,
    readiness,
    workersAtReadiness,
    resources,
    workerHeapComplete:
      resources.workers !== undefined && resources.workers.workerMemoryMissing.length === 0,
    shutdown,
    workersAfterShutdown: workerCounts(),
    physicalWorkersAliveAfterProcessExit: 0,
    hostLoadStart,
    hostLoadEnd: loadavg(),
    instrumentation:
      "Cold compile cache disabled; physical Worker create/exit events, including nested supervisors; no forced GC. Detailed census follows readiness counts.",
  };
} catch (error) {
  result = { error: String(error), workers: workerCounts(), hostLoadStart, hostLoadEnd: loadavg() };
  throw error;
} finally {
  clearTimeout(watchdog);
  if (alive()) {
    stopOwnedChild();
  }
  await exited;
  clearTimeout(forcedKill);
  process.off("SIGINT", stopOwnedChild);
  process.off("SIGTERM", stopOwnedChild);
  closeSync(fd);
  result.childExit = { code: child.exitCode, signal: child.signalCode };
  result.workersAfterShutdown = workerCounts();
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
}
console.log(
  JSON.stringify({
    output,
    readyMs: result.ready.ms,
    workersAtReadiness: result.workersAtReadiness,
  }),
);
