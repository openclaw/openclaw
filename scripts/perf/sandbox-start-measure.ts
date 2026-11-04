/**
 * Warm sandbox provisioning owner CPU/allocation benchmark, with real mount
 * preparation, registry storage and subprocess execution against a synthetic
 * shell container engine (no daemon or credentials). Forty read-only resource
 * mounts model a populated sandbox. This excludes real daemon latency and
 * child-process CPU; pair with the Gateway/native Docker proof for those costs.
 *
 * Run already-built baseline/candidate owners in counterbalanced order:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sandbox-start-measure.ts \
 *   --owner <dist/docker-*.mjs exporting ensureSandboxContainer> --iterations 2000
 * Built owners are preferred; source owners also work through the tsx loader:
 *   --owner src/agents/sandbox/backend.ts --backend --engine podman --iterations 2000
 * Record the source revision/diff for source runs; the owner hash covers its entry.
 * Add --allocations for a separate collected-object sampling pass. Setup, warmup
 * and forced GC are outside measurement. Each invocation owns and removes its
 * fixture under .local; never points at a running Gateway or real container engine.
 * Timing/GC values from the sampled pass are diagnostic only. Both revisions
 * use the same current-source sandbox config factory, whose hash is reported.
 * --cold-create makes the synthetic engine report each container absent, measuring
 * image admission/create/start work without real daemon latency or image pulls.
 * --backend selects an owner exporting createSandboxBackend instead, including
 * backend dispatch, daemon identity, filesystem-bridge setup and registry publication.
 * --engine docker|podman selects the synthetic engine (default: docker); Podman
 * models a local rootless engine, including its native target-resolution probes.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { constants, PerformanceObserver, type PerformanceNodeEntry } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
    "cold-create": { type: "boolean", default: false },
    backend: { type: "boolean", default: false },
    engine: { type: "string", default: "docker" },
  },
});
assert(values.owner, "--owner must select a built or source sandbox owner");
const engine = values.engine;
assert(engine === "docker" || engine === "podman", "--engine must be docker or podman");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 2000,
});
await fs.mkdir(".local", { recursive: true });
const root = await fs.mkdtemp(path.resolve(".local/sandbox-start-measure-"));
const workspaceDir = path.join(root, "workspace");
const bin = path.join(root, "bin");
const callsFile = path.join(root, "calls");
const containerId = "c".repeat(64);
await fs.mkdir(workspaceDir);
await fs.mkdir(bin);
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_HOME: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  SANDBOX_MEASURE_CALLS: callsFile,
  SANDBOX_MEASURE_CONTAINER: path.join(root, "container"),
  SANDBOX_MEASURE_ID: containerId,
  SANDBOX_MEASURE_COLD: values["cold-create"] ? "1" : "0",
  SANDBOX_MEASURE_ENGINE: engine,
});
for (const name of [
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
]) {
  delete process.env[name];
}
await fs.writeFile(
  path.join(bin, engine),
  `#!/bin/sh
if [ "$1" = --host ]; then shift 2; fi
printf '%s\n' "$1" >> "$SANDBOX_MEASURE_CALLS"
case "$1" in
  context) printf '{"Host":"unix:///synthetic-sandbox.sock"}\n' ;;
  info)
    if [ "$SANDBOX_MEASURE_ENGINE" = podman ]; then
      printf 'true\tfalse\t\t5.0.0\n'
    else
      printf 'synthetic-daemon\n'
    fi ;;
  inspect)
    if [ "$3" = '{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}' ]; then
      printf '{"Mounts":[],"Tmpfs":{}}\n'
      exit 0
    fi
    if [ "$3" = '{{json .State}}' ]; then
      printf '{"Running":true,"Paused":false,"Pid":123,"StartedAt":"2026-01-01T00:00:00Z"}\n'
      exit 0
    fi
    if [ "$SANDBOX_MEASURE_COLD" = 1 ] || [ ! -f "$SANDBOX_MEASURE_CONTAINER" ]; then
      printf 'No such container\n' >&2
      exit 1
    fi
    read -r config_hash < "$SANDBOX_MEASURE_CONTAINER"
    case "$3" in
      '{{.State.Running}}') printf 'true\n' ;;
      '{{.Id}} {{.HostConfig.ReadonlyRootfs}}') printf '%s true\n' "$SANDBOX_MEASURE_ID" ;;
      *'.State.Running}'*'.HostConfig.ReadonlyRootfs}'*) printf '%s\ntrue\ntrue\n%s\n' "$SANDBOX_MEASURE_ID" "$config_hash" ;;
      *'openclaw.configHash'*) printf '%s\n' "$config_hash" ;;
      '{{.Id}}') printf '%s\n' "$SANDBOX_MEASURE_ID" ;;
      *) printf 'Unsupported fixture inspection\n' >&2; exit 2 ;;
    esac ;;
  create)
    for argument do
      case "$argument" in
        openclaw.configHash=*) printf '%s\n' "\${argument#openclaw.configHash=}" > "$SANDBOX_MEASURE_CONTAINER" ;;
      esac
    done
    printf '%s\n' "$SANDBOX_MEASURE_ID" ;;
  exec) printf '1 0 8:1 / / rw - ext4 /dev/synthetic rw\n' ;;
  image|start) ;;
  *) printf 'Unsupported fixture operation\n' >&2; exit 2 ;;
esac
`,
  { mode: 0o700 },
);
const inspector = new Session();
let gcMs = 0;
let gcCount = 0;
let maxPauseMs = 0;
let measuredStart = Number.POSITIVE_INFINITY;
let measuredEnd = Number.POSITIVE_INFINITY;
const gcByKind: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
const gcKindNames = new Map([
  [constants.NODE_PERFORMANCE_GC_MINOR, "minor"],
  [constants.NODE_PERFORMANCE_GC_MAJOR, "major"],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, "weakCallbacks"],
]);
const gc = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime < measuredStart || entry.startTime >= measuredEnd) {
      continue;
    }
    gcMs += entry.duration;
    gcCount++;
    maxPauseMs = Math.max(maxPauseMs, entry.duration);
    const kind = (entry as PerformanceNodeEntry).detail.kind;
    const stats = (gcByKind[gcKindNames.get(kind) ?? String(kind)] ??= {
      count: 0,
      totalMs: 0,
      maxMs: 0,
    });
    stats.count++;
    stats.totalMs += entry.duration;
    stats.maxMs = Math.max(stats.maxMs, entry.duration);
  }
});
try {
  const { resolveSandboxConfigForAgent } = await import("../../src/agents/sandbox/config.js");
  const owner = await import(pathToFileURL(path.resolve(values.owner)).href);
  const readOnlyResourceMounts: Array<{ hostPath: string; containerPath: string }> = [];
  for (let index = 0; index < 40; index++) {
    const hostPath = path.join(root, `resource-${index}`);
    await fs.mkdir(hostPath);
    await fs.writeFile(path.join(hostPath, "SKILL.md"), `Synthetic skill ${index}\n`);
    readOnlyResourceMounts.push({ hostPath, containerPath: `/resources/skill-${index}` });
  }
  const cfg = resolveSandboxConfigForAgent({
    agents: {
      defaults: {
        sandbox: { mode: "all", backend: engine, scope: "shared", workspaceAccess: "rw" },
      },
    },
  });
  const params = {
    scopeKey: "sandbox-start-measure",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    readOnlyResourceMounts,
    cfg,
  };
  const invoke = values.backend
    ? async () => {
        const { createSandboxBackend } =
          owner as typeof import("../../src/agents/sandbox/backend.js");
        const result = await createSandboxBackend({ ...params, sessionKey: params.scopeKey });
        assert.equal(
          result.runtimeId,
          `${cfg.docker.containerPrefix}${engine === "podman" ? "podman-" : ""}shared`,
        );
      }
    : async () => {
        const { ensureSandboxContainer, DOCKER_SANDBOX_ENGINE, PODMAN_SANDBOX_ENGINE } =
          owner as typeof import("../../src/agents/sandbox/docker.js");
        const result = await ensureSandboxContainer({
          ...params,
          engine: engine === "podman" ? PODMAN_SANDBOX_ENGINE : DOCKER_SANDBOX_ENGINE,
        });
        assert.equal(result.containerId, containerId);
        assert.equal(result.currentConfig, true);
      };
  for (let index = 0; index < 10; index++) {
    await invoke();
  }
  await fs.writeFile(callsFile, "");
  global.gc();
  await setImmediate();
  const barrierStarted = performance.now();
  await setTimeout(100);
  const postWarmBarrierElapsedMs = performance.now() - barrierStarted;
  gc.observe({ entryTypes: ["gc"] });
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const loadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const measurementStartedAt = new Date().toISOString();
  measuredStart = performance.now();
  const durations: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    await invoke();
    durations.push(performance.now() - start);
  }
  measuredEnd = performance.now();
  const elapsedMs = measuredEnd - measuredStart;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  await setImmediate();
  gc.disconnect();
  let sampledBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = 0;
    const nodes = [profile.head];
    for (const node of nodes) {
      sampledBytes += node.selfSize;
      nodes.push(...node.children);
    }
  }
  const calls = (await fs.readFile(callsFile, "utf8")).trim().split("\n");
  const callsByOperation = Object.fromEntries(
    ["inspect", "image", "create", "start", "context", "info", "exec"].map((operation) => [
      operation,
      calls.filter((call) => call === operation).length / iterations,
    ]),
  );
  if (values["cold-create"]) {
    assert.equal(callsByOperation.create, 1);
    assert.equal(callsByOperation.start, 1);
  } else {
    assert(
      calls.every((call) => ["inspect", "context", "info", "exec"].includes(call)),
      "Warm reuse must not mutate the container",
    );
  }
  durations.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      owner: path.resolve(values.owner),
      ownerArtifactSha256: hash("sha256", await fs.readFile(path.resolve(values.owner))),
      harnessSha256: hash("sha256", await fs.readFile(new URL(import.meta.url))),
      configFactorySha256: hash(
        "sha256",
        await fs.readFile(new URL("../../src/agents/sandbox/config.ts", import.meta.url)),
      ),
      iterations,
      resourceMounts: readOnlyResourceMounts.length,
      allocations: values.allocations,
      coldCreate: values["cold-create"],
      backend: values.backend,
      engine,
      callsByOperation,
      timingAndGcDiagnosticOnly: values.allocations,
      postWarmBarrierMs: 100,
      postWarmBarrierElapsedMs,
      measurementStartedAt,
      processAgeAtMeasurementStartMs: measuredStart,
      inspectCallsPerTurn: callsByOperation.inspect,
      engineCallsPerTurn: calls.length / iterations,
      elapsedMs,
      cpuUsPerTurn: (used.user + used.system) / iterations,
      sampledBytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      p50Ms: durations[Math.floor(iterations * 0.5)],
      p95Ms: durations[Math.min(iterations - 1, Math.floor(iterations * 0.95))],
      gcMs,
      gcCount,
      maxPauseMs,
      gcByKind,
      memoryBefore,
      memoryAfter,
      loadBefore,
      loadAfter: loadavg(),
    }),
  );
} finally {
  gc.disconnect();
  if (values.allocations) {
    inspector.disconnect();
  }
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  await drainGlobalSingletonLifecycleState();
  await fs.rm(root, { recursive: true, force: true });
}
