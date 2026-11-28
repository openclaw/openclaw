/**
 * Owner probe: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/worker-request-diagnostics-measure.ts --output .local/l1755/base.json
 * Run unchanged on both revisions, alternating order. Defaults: five warm 10k-task
 * timing passes and a separate 50k-task sampled-allocation pass. This exercises
 * the real worker-request owner, exporter capability, and HTTP scrape; it does
 * not execute Git or replace the canonical ten-minute built-Gateway stress run.
 * Compare CPU/task and allocation/task; retain GC, loop tails, and host load as
 * context, requiring matched A/A controls before declaring an adverse result.
 * Add --git --tasks 100 --repeats 5 for 1,021 real worker reads of a temporary
 * synthetic Git repository (four concurrent clients; fixture removed on exit).
 * The .metrics file uses a fixed clock so worker metric bytes must match exactly.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createDiagnosticsPrometheusExporter } from "../../extensions/diagnostics-prometheus/src/service.js";
import { waitForDiagnosticEventsDrained } from "../../src/infra/diagnostic-events.js";
import { trackWorkerRequest } from "../../src/infra/worker-request-diagnostics.js";
import { workerRequestKind } from "../../src/infra/worker-request-kind.js";
import { createPluginRuntimeCapabilityLease } from "../../src/plugins/capability-lease.js";
import { withPluginRuntimeGatewayRequestScope } from "../../src/plugins/runtime/gateway-request-scope.js";
import { createPluginServiceDiagnostics } from "../../src/plugins/service-diagnostics.js";
import { drainGlobalSingletonLifecycleState } from "../../src/shared/global-singleton.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    tasks: { type: "string" },
    repeats: { type: "string" },
    output: { type: "string" },
    port: { type: "string" },
    git: { type: "boolean", default: false },
  },
});
const tasks = parseStrictIntegerOption({
  raw: values.tasks,
  fallback: 10_000,
  min: 1,
  label: "tasks",
});
const repeats = parseStrictIntegerOption({
  raw: values.repeats,
  fallback: 5,
  min: 1,
  label: "repeats",
});
const port = parseStrictIntegerOption({
  raw: values.port,
  fallback: 41755,
  min: 40000,
  label: "port",
});
assert(port <= 65535, "port must be <= 65535");
assert(global.gc, "run with --expose-gc");
const kind = workerRequestKind(new URL("../../src/infra/git-operation.worker.ts", import.meta.url));
const exporter = createDiagnosticsPrometheusExporter();
const lease = createPluginRuntimeCapabilityLease("diagnostics-prometheus");
const internalDiagnostics = createPluginServiceDiagnostics(
  {
    id: "diagnostics-prometheus",
    pluginId: "diagnostics-prometheus",
    origin: "bundled",
    source: "synthetic-worker-measurement",
    service: exporter.service,
  },
  lease,
);
assert(internalDiagnostics);
const context = {
  config: {},
  stateDir: ".local/l1755/synthetic",
  internalDiagnostics,
  logger: {
    info() {},
    warn() {},
    debug() {},
    error(message: string) {
      throw new Error(message);
    },
  },
};
const server = createServer((req, res) => {
  void withPluginRuntimeGatewayRequestScope(
    {
      isWebchatConnect: () => false,
      client: {
        connId: "synthetic-scrape",
        usesSharedGatewayAuth: false,
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "gateway-client", version: "synthetic", platform: "node", mode: "backend" },
          scopes: ["operator.read"],
        },
      },
    },
    () => exporter.handler(req, res),
  );
});
async function scrape() {
  const address = server.address();
  assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
  assert.equal(response.status, 200);
  return (
    (await response.text())
      .split("\n")
      .filter((line) => line.includes("openclaw_worker_"))
      .join("\n") + "\n"
  );
}
async function runOwner(count: number) {
  for (let offset = 0; offset < count; offset += 100) {
    for (let index = offset; index < Math.min(offset + 100, count); index++) {
      const observation = trackWorkerRequest(kind, "task");
      observation.started();
      observation.completed();
    }
    await waitForDiagnosticEventsDrained();
    await yieldImmediate();
  }
}
let run = runOwner;
let gitDirectory: string | undefined;
async function prepareGitFixture() {
  const parent = resolve(".local/l1755");
  await mkdir(parent, { recursive: true });
  gitDirectory = await mkdtemp(`${parent}/git-fixture-`);
  process.env.OPENCLAW_STATE_DIR = `${gitDirectory}/state`;
  process.env.DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: gitDirectory,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: "pipe",
    });
  git(["init", "--initial-branch=main"]);
  await writeFile(`${gitDirectory}/fixture.txt`, "synthetic worker measurement\n");
  git(["add", "fixture.txt"]);
  git([
    "-c",
    "user.name=Synthetic Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "synthetic fixture",
  ]);
  const { runGitWorkerOperation } = await import("../../src/infra/git-worker.js");
  const command = {
    type: "checkout.revision" as const,
    input: { root: gitDirectory, scope: "refs" as const },
  };
  const expected = await runGitWorkerOperation(command);
  assert.equal(typeof expected, "string");
  run = async (count: number) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next++ < count) {
          assert.equal(await runGitWorkerOperation(command), expected);
        }
      }),
    );
    await waitForDiagnosticEventsDrained();
  };
}
function tails(samples: number[]) {
  samples.sort((a, b) => a - b);
  return {
    samples: samples.length,
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1] ?? null,
    p99Ms: samples[Math.ceil(samples.length * 0.99) - 1] ?? null,
    maxMs: samples.at(-1) ?? null,
    totalMs: samples.reduce((sum, value) => sum + value, 0),
  };
}
async function timingPass() {
  global.gc!();
  const gc = { minor: [] as number[], major: [] as number[], other: [] as number[] };
  let started = Infinity;
  let ended = Infinity;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime < started || entry.startTime > ended) {
        continue;
      }
      const detail = (entry as typeof entry & { detail: { kind: number } }).detail;
      const category =
        detail.kind === constants.NODE_PERFORMANCE_GC_MINOR
          ? "minor"
          : detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR
            ? "major"
            : "other";
      gc[category].push(entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  await yieldImmediate();
  const hostLoad = loadavg();
  const before = process.threadCpuUsage();
  started = performance.now();
  await run(tasks);
  ended = performance.now();
  const cpu = process.threadCpuUsage(before);
  await yieldImmediate();
  observer.disconnect();
  loop.disable();
  const wallMs = ended - started;
  const gcMs = [...gc.minor, ...gc.major, ...gc.other].reduce((sum, value) => sum + value, 0);
  return {
    tasks,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuUsPerTask: (cpu.user + cpu.system) / tasks,
    hostLoad,
    memory: process.memoryUsage(),
    gc: {
      minor: tails(gc.minor),
      major: tails(gc.major),
      other: tails(gc.other),
      msPerTask: gcMs / tasks,
      msPerMinute: (gcMs * 60_000) / wallMs,
    },
    loop: {
      samples: loop.count,
      p95Ms: loop.percentile(95) / 1e6,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
    },
  };
}
async function allocationPass() {
  global.gc!();
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await run(tasks * repeats);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    let bytes = 0;
    let ownerBytes = 0;
    function visit(node: HeapProfiler.SamplingHeapProfileNode, owned = false) {
      const underOwner =
        owned ||
        node.callFrame.functionName === "trackWorkerRequest" ||
        node.callFrame.url.includes("/diagnostic-events.");
      bytes += node.selfSize;
      if (underOwner) {
        ownerBytes += node.selfSize;
      }
      for (const child of node.children) {
        visit(child, underOwner);
      }
    }
    visit(profile.head);
    return {
      tasks: tasks * repeats,
      sampledBytes: bytes,
      bytesPerTask: bytes / (tasks * repeats),
      ownerBytes,
      ownerBytesPerTask: ownerBytes / (tasks * repeats),
    };
  } finally {
    inspector.disconnect();
  }
}

try {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  exporter.service.start(context);
  const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
  let clock = 1_000;
  let golden: string;
  try {
    Object.defineProperty(performance, "now", { configurable: true, value: () => clock++ });
    await run(10);
    golden = await scrape();
  } finally {
    if (originalNow) {
      Object.defineProperty(performance, "now", originalNow);
    } else {
      Reflect.deleteProperty(performance, "now");
    }
  }
  assert(
    golden.includes(
      `openclaw_worker_request_seconds_count{kind="${kind}",request_class="task"} 10`,
    ),
  );
  exporter.service.stop();
  exporter.service.start(context);
  if (values.git) {
    await prepareGitFixture();
  }
  const warmup = values.git ? 20 : 1000;
  await run(warmup);
  const timings = [];
  for (let index = 0; index < repeats; index++) {
    timings.push(await timingPass());
  }
  const allocation = await allocationPass();
  const metrics = await scrape();
  const expectedCount = warmup + tasks * repeats * 2 + (values.git ? 1 : 0);
  const recordedCount = metrics
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("openclaw_worker_request_seconds_count{") &&
        line.includes(`kind="${kind}"`),
    )
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
  assert.equal(recordedCount, expectedCount);
  const result = {
    node: process.version,
    kind,
    workload: values.git
      ? "four concurrent real Git worker checkout.revision reads"
      : "worker diagnostics owner only; no Git execution",
    timings,
    allocation,
    expectedCount,
    golden,
  };
  const json = JSON.stringify(result, null, 2) + "\n";
  if (values.output) {
    await mkdir(dirname(values.output), { recursive: true });
    await writeFile(values.output, json);
    await writeFile(`${values.output}.metrics`, golden);
  }
  console.log(json);
} finally {
  exporter.service.stop();
  lease.revoke();
  if (values.git) {
    await drainGlobalSingletonLifecycleState();
  }
  if (gitDirectory) {
    await rm(gitDirectory, { recursive: true, force: true });
  }
  server.closeAllConnections();
  await new Promise<void>((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
  });
}
