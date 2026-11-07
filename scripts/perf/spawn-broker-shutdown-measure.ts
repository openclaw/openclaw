/**
 * Measure the Gateway runtime owner after a required core cleanup is retained.
 * Run serial A/B pairs (at least five each) and identical A/A controls, each in
 * a new --state-dir. Accept zero lost outcomes/failed extinction joins, bounded
 * by the existing 5s process budget; compare median/p95 host CPU and owner time.
 * Profile allocations separately: inspector sampling changes the timed workload.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/spawn-broker-shutdown-measure.ts \
 *   --state-dir /absolute/new-fixture --broker [--allocation]
 * --server-source loads a saved baseline server.ts at its original module URL;
 * all unchanged dependencies stay identical. --source-root selects another checkout.
 *
 * This is process-owner attribution, not whole-Gateway or database scaling proof.
 * The fixture owns one real command, broker, relay and anchor. The core stub
 * returns the same retained-cleanup error as the received-connection deadline;
 * it does not boot agents or scan sessions/workspaces. Padding a 35GiB database
 * or 62k-file workspace would not exercise this owner. No Team data is used.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SpawnBrokerHost } from "../../src/process/spawn-broker/host.js";
import type { ManagedRun, RunExit } from "../../src/process/supervisor/types.js";

type Observed<T> = { status: "fulfilled"; value: T } | { status: "rejected"; errors: string[] };

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "source-root": { type: "string" },
    "server-source": { type: "string" },
    "native-owner": { type: "string" },
    broker: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "Pass a new isolated --state-dir");
assert(!process.versions.bun, "This probe uses Node module hooks; Bun uses native transport tests");
assert(process.platform !== "win32", "The command fixture requires POSIX signals");
const directory = path.resolve(values["state-dir"]);
await mkdir(directory); // Refuse another run's state.
const home = path.join(directory, "home");
await mkdir(home);
process.env.OPENCLAW_HOME = home;
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = path.join(directory, "openclaw.json");
process.env.OPENCLAW_EXEC_SHELL_SNAPSHOT = "0";
const sourceRoot = path.resolve(
  values["source-root"] ?? fileURLToPath(new URL("../../", import.meta.url)),
);
const moduleUrl = (relative: string) => pathToFileURL(path.join(sourceRoot, relative)).href;
const serverUrl = moduleUrl("src/gateway/server.ts");
const actualPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const messages: string[] = [];
const errors = (error: unknown): string[] =>
  error instanceof Error
    ? [
        error.message,
        ...(error instanceof AggregateError ? error.errors.flatMap(errors) : []),
        ...(error.cause ? errors(error.cause) : []),
      ]
    : [String(error)];
const observe = async <T>(promise: Promise<T>) => {
  try {
    return { status: "fulfilled" as const, value: await promise };
  } catch (error) {
    return { status: "rejected" as const, errors: errors(error) };
  }
};
async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("measurement deadline exceeded")),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const { getSpawnBroker } = await import(moduleUrl("src/process/spawn-broker/context.ts"));
const {
  getProcessSupervisor,
  shutdownProcessSupervisor,
}: typeof import("../../src/process/supervisor/index.js") = await import(
  moduleUrl("src/process/supervisor/index.ts")
);
const { runWithProcessCleanupBudget } = await import(
  moduleUrl("src/process/supervisor/cleanup-budget.ts")
);
const { GatewayShutdownCleanupRetainedError } = await import(
  moduleUrl("src/gateway/server-shutdown.ts")
);
// Source-loader compiler children cannot share the anchor's exclusive native wait.
const nativeDirectory = path.join(directory, "native");
await mkdir(nativeDirectory);
const nativeEntry = path.join(nativeDirectory, "service-child-group-anchor.mjs");
if (values["native-owner"]) {
  await writeFile(
    nativeEntry,
    `await import(${JSON.stringify(pathToFileURL(path.resolve(values["native-owner"])).href)});\n`,
  );
} else {
  const { build } = await import("esbuild");
  await symlink(
    path.join(sourceRoot, "node_modules"),
    path.join(nativeDirectory, "node_modules"),
    "dir",
  );
  await build({
    absWorkingDir: sourceRoot,
    entryPoints: ["src/process/supervisor/service-child-group-anchor.ts"],
    outfile: nativeEntry,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    define: { WORKER_DEPLOY_BUILD: "false" },
    logLevel: "warning",
  });
}
const { registerSealedRuntimeProcessEntrypoints } = await import(
  moduleUrl("src/infra/runtime-process-url.ts")
);
registerSealedRuntimeProcessEntrypoints(
  "serviceChildRelay",
  pathToFileURL(path.join(nativeDirectory, "fixture.mjs")).href,
);
const supervisor = getProcessSupervisor();
const closeScope = supervisor.acquireScopeCleanup("shutdown-measure", {
  processTree: "required-all",
});
let broker: SpawnBrokerHost | undefined;
let run: ManagedRun | undefined;
let result: Promise<Observed<RunExit>> | undefined;
let extinction: Promise<Observed<void>> | undefined;
const coreKey = "openclaw.spawn-broker-shutdown-measure";
Object.defineProperty(globalThis, Symbol.for(coreKey), {
  value: {
    async start() {
      Object.defineProperty(process, "platform", actualPlatform);
      broker = getSpawnBroker();
      let ready!: () => void;
      const readiness = new Promise<void>((resolve) => {
        ready = resolve;
      });
      run = await supervisor.spawn({
        mode: "child",
        scopeKey: "shutdown-measure",
        argv: [
          process.execPath,
          "-e",
          `
          process.on('SIGTERM', () => process.stdout.write('final-marker\\n', () => process.exit(0)));
          setInterval(() => {}, 1000);
          process.stdout.write('ready-marker\\n');
        `,
        ],
        cwd: directory,
        env: { HOME: home, PATH: process.env.PATH },
        stdinMode: "pipe-closed",
        onStdout: (chunk: string) => {
          if (chunk.includes("ready-marker")) {
            ready();
          }
        },
      });
      result = observe(run.wait());
      extinction = observe(Promise.resolve(run.waitForExtinction?.()).then(() => {}));
      await beforeDeadline(
        Promise.race([
          readiness,
          result.then(() => {
            throw new Error("Command exited before readiness");
          }),
        ]),
        performance.now() + 10_000,
      );
      return {
        startupSettled: Promise.resolve(),
        getTailscaleIngressEndpoint: () => undefined,
        async close() {
          throw new GatewayShutdownCleanupRetainedError([
            new Error("synthetic received connection work retained"),
          ]);
        },
      };
    },
    log(message: string) {
      messages.push(message);
    },
  },
});
const core = `export const startGatewayServerCore = () => globalThis[Symbol.for(${JSON.stringify(coreKey)})].start();`;
const logger = `export const createSubsystemLogger = () => ({info() {}, error(message) {globalThis[Symbol.for(${JSON.stringify(coreKey)})].log(message)}});`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === serverUrl) {
      const requested = specifier.startsWith(".") ? new URL(specifier, serverUrl).href : specifier;
      const source =
        requested === new URL("./server-start.js", serverUrl).href
          ? core
          : requested === new URL("../logging/subsystem.js", serverUrl).href
            ? logger
            : undefined;
      if (source) {
        return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === serverUrl && values["server-source"]) {
      return {
        format: "module-typescript",
        source: readFileSync(values["server-source"], "utf8"),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
// Select only the Gateway's transport branch; the core restores the actual OS
// before constructing real service-child owners. Linux needs no override.
if (values.broker) {
  Object.defineProperty(process, "platform", { ...actualPlatform, value: "linux" });
}
const { startGatewayServer } = await import(serverUrl);
// The core fixture has no shared-state users; no operator lease is acquired.
const server = await startGatewayServer(0, { gatewayStateOwner: { assertDatabaseAccess() {} } });
assert(run && result && extinction, "Core did not start the owned command");
if (values.broker) {
  assert(broker, "Gateway broker was unavailable during setup");
}
const inspector = new Session();
const samplingInterval = 32_768;
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpu = process.cpuUsage();
const start = performance.now();
const deadline = start + 5_000;
// A retained production owner can keep handles alive after its deadline. The
// isolated harness reports that failure and bounds its own process lifetime.
const hardStop = setTimeout(() => {
  console.error(
    JSON.stringify({ failure: "measurement process retained native resources after deadline" }),
  );
  process.exit(2);
}, 10_000);
hardStop.unref();
const observed = await runWithProcessCleanupBudget(
  { deadline, warn: (message: string) => messages.push(message) },
  async () => {
    const close = await observe(beforeDeadline(server.close({ exitAfterClose: true }), deadline));
    const closeMs = performance.now() - start;
    // The CLI performs this fallback only after server.close returns or rejects.
    const supervisorClose = await observe(beforeDeadline(shutdownProcessSupervisor(), deadline));
    const outcomes = await observe(beforeDeadline(Promise.all([result, extinction]), deadline));
    return { close, closeMs, supervisorClose, outcomes };
  },
);
const elapsedMs = performance.now() - start;
const cpuUsage = process.cpuUsage(cpu);
let allocatedBytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  inspector.disconnect();
}
const scope = await observe(beforeDeadline(closeScope(), deadline));
hooks.deregister();
console.log(
  JSON.stringify({
    runtime: process.version,
    platform: actualPlatform.value,
    transport: broker ? "broker" : "native",
    sourceRoot,
    serverSource: values["server-source"] ?? serverUrl,
    hostLoad: os.loadavg(),
    deadlineMs: 5_000,
    elapsedMs,
    hostCpuMs: (cpuUsage.user + cpuUsage.system) / 1000,
    lostBrokerOutcome: JSON.stringify(observed).includes(
      "Spawn broker exited; command outcome is unavailable",
    ),
    ...(values.allocation ? { samplingInterval, allocatedBytes } : {}),
    ...observed,
    scope,
    messages,
  }),
);
// Baseline failures are reported above. Only a healthy retained-close fixture
// with a delivered final marker and confirmed extinction receives success.
const [outcome, extinct] = observed.outcomes.status === "fulfilled" ? observed.outcomes.value : [];
process.exitCode =
  observed.close.status === "rejected" &&
  observed.close.errors.includes("synthetic received connection work retained") &&
  outcome?.status === "fulfilled" &&
  outcome.value.stdout.includes("final-marker") &&
  extinct?.status === "fulfilled" &&
  scope.status === "fulfilled" &&
  elapsedMs < 5_000
    ? 0
    : 1;
