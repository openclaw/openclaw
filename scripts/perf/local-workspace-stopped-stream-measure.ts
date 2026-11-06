/**
 * Stopped-stream reconciliation owner benchmark with a real local Docker engine.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-stopped-stream-measure.ts
 *   --output .local/buf595-owner-base --iterations 200 --revision <base-sha>
 * Omit --revision for the working-tree quiescence owner. Run fresh AB/BA processes.
 * --instrument allocation samples main-thread allocations separately from timing.
 * A real parent mounts the synthetic directory. A real child is created and then
 * removed by stopDockerPersistentExec, whose extinction proof binds the fixture's
 * stopped receipt. Registry/persistence are explicit in-memory boundary fixtures;
 * no Gateway or durable state/lease is measured. Container CLI calls, parent pause
 * and resume, daemon checks and missing-child inspection use the real engine.
 * Report owner CPU/allocation and engine calls per operation separately from the
 * real-Gateway convoy harness. This is not proof of production call frequency.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type { LocalWorkspacePausedRuntime } from "../../src/agents/sandbox/local-workspace-quiescence.js";
import type { SandboxPersistentExecRecord } from "../../src/agents/sandbox/persistent-exec-store.types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    revision: { type: "string" },
    iterations: { type: "string", default: "200" },
    instrument: { type: "string", default: "timing" },
  },
});
assert(values.output, "--output must name a new synthetic fixture directory");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["timing", "allocation"].includes(values.instrument!));
const output = path.resolve(values.output);
fs.mkdirSync(output);
process.env.OPENCLAW_STATE_DIR = path.join(output, "state");
process.env.TMPDIR = output;
const workspaceDir = path.join(output, "workspace");
fs.mkdirSync(workspaceDir);
fs.writeFileSync(path.join(workspaceDir, "fixture.txt"), "synthetic workspace\n");
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownerFile = "src/agents/sandbox/local-workspace-quiescence.ts";
const ownerSource = values.revision
  ? execFileSync("git", ["show", `${values.revision}:${ownerFile}`], {
      cwd: sourceRoot,
      encoding: "utf8",
      env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
    })
  : fs.readFileSync(path.join(sourceRoot, ownerFile), "utf8");
const prefix = `openclaw-buf595-owner-${randomUUID().slice(0, 8)}`;
const parentName = `${prefix}-parent`;
const containers = new Set<string>();
const environment = { ...process.env, TMPDIR: output };
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", env: environment }).trim();
function retain(id: string) {
  assert(/^[a-f0-9]{64}$/u.test(id));
  containers.add(id);
  fs.writeFileSync(
    path.join(output, "owned-containers.json"),
    JSON.stringify({ ids: [...containers] }, null, 2),
  );
  return id;
}
let parent:
  | {
      containerName: string;
      backendId: "docker";
      workspaceDir: string;
      backendTarget: import("../../src/agents/sandbox/container-engine.js").SandboxContainerEngineTarget;
    }
  | undefined;
let record: SandboxPersistentExecRecord | undefined;
let active = true,
  measuring = false;
let custodyChecks = 0,
  writes = 0;
const engineCalls: Array<{ operation: string; target: string; ms: number }> = [];
const assertCurrent = () => assert(active, "Synthetic owner ended");
Object.assign(globalThis, {
  __buf595Stopped: {
    read: async () => {
      assertCurrent();
      return { entries: parent ? [parent] : [] };
    },
    browsers: async () => ({ entries: [] }),
    current: (_kind: string, entry: unknown) => {
      assertCurrent();
      assert.equal(entry, parent);
    },
    store: () => ({
      databasePath: path.join(output, "synthetic-boundary.sqlite"),
      environment: {},
      assertCurrent,
      list: async (query: { ownerKey?: string } = {}) => {
        assertCurrent();
        return record && (!query.ownerKey || query.ownerKey === record.ownerKey) ? [record] : [];
      },
      assertCustodyCurrent: async (expected: unknown) => {
        assertCurrent();
        assert.equal(expected, record);
        if (measuring) {
          custodyChecks++;
        }
      },
    }),
    engine(args: string[], ms: number) {
      if (!measuring) {
        return;
      }
      engineCalls.push({
        operation: args[0] ?? "unknown",
        target:
          record?.receipt && args.includes(record.receipt.containerId)
            ? "removed-child"
            : parent &&
                (args.includes(parent.containerName) ||
                  (record && args.includes(record.containerId)))
              ? "parent"
              : "daemon",
        ms,
      });
    },
  },
});
function replaceOnce(code: string, anchor: string, replacement: string) {
  assert.equal(code.split(anchor).length, 2, `Instrumentation anchor changed: ${anchor}`);
  return code.replace(anchor, replacement);
}
registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(sourceRoot, fileURLToPath(url)) : "";
    let code: string | undefined;
    if (relative === ownerFile) {
      code = ownerSource;
    }
    // These are the declared owner boundary fixtures, not production registry receipts.
    if (relative === "src/agents/sandbox/registry.ts") {
      code = `
    export const readRegistry = globalThis.__buf595Stopped.read;
    export const readBrowserRegistry = globalThis.__buf595Stopped.browsers;
    export const assertSandboxRegistryRetirementCurrent = globalThis.__buf595Stopped.current;
    export const assertSandboxRegistryEntryCurrent = () => { throw Error('Not an image-read fixture'); };
    export const assertSandboxBrowserRegistryEntryCurrent = () => { throw Error('No browser fixture'); };
  `;
    }
    if (relative === "src/agents/sandbox/persistent-exec-store.ts") {
      code = "export const createSandboxPersistentExecStore = globalThis.__buf595Stopped.store;";
    }
    if (relative === "src/agents/sandbox/browser-bridges.ts") {
      code = "export const BROWSER_BRIDGES = new Map();";
    }
    // Preserve real engine operations while avoiding unrelated provisioning imports.
    if (relative === "src/agents/sandbox/docker.ts") {
      code = `
    export { DOCKER_SANDBOX_ENGINE, execContainer } from './container-engine.js';
    export { bindPodmanSandboxEngine, validateSandboxContainerEngineTarget } from './podman-runtime.js';
  `;
    }
    if (relative === "src/agents/sandbox/container-engine.ts") {
      code = fs.readFileSync(path.join(sourceRoot, relative), "utf8");
      code = replaceOnce(
        code,
        "  const result = await execContainerRaw(engine, args, opts);",
        "  const __started = performance.now();\n  const result = await execContainerRaw(engine, args, opts);\n  globalThis.__buf595Stopped.engine(args, performance.now() - __started);",
      );
    }
    return code === undefined
      ? nextLoad(url, context)
      : {
          format: "module",
          source: transformSync(code, { loader: "ts", format: "esm", target: "esnext" }).code,
          shortCircuit: true,
        };
  },
});
function stats(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    meanMs: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
    p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? null,
    p99Ms: sorted[Math.floor((sorted.length - 1) * 0.99)] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}
const inspector = values.instrument === "allocation" ? new Session() : undefined;
const loop = monitorEventLoopDelay({ resolution: 10 });
let gcMs = 0;
const gc = new PerformanceObserver((entries) => {
  for (const entry of entries.getEntries()) {
    gcMs += entry.duration;
  }
});
const failures: unknown[] = [];
try {
  const parentId = retain(
    docker(
      "run",
      "-d",
      "--name",
      parentName,
      "--network",
      "none",
      "--mount",
      `type=bind,source=${workspaceDir},target=/workspace`,
      "openclaw-sandbox:bookworm-slim",
      "sleep",
      "infinity",
    ),
  );
  const { captureDockerPersistentTarget, dockerPersistentTargetToEngineTarget } =
    await import("../../src/agents/sandbox/docker-persistent-target.js");
  const target = await captureDockerPersistentTarget();
  assert(target, "The stopped-stream fixture needs a local Unix-socket Docker target");
  parent = {
    containerName: parentName,
    backendId: "docker",
    workspaceDir,
    backendTarget: dockerPersistentTargetToEngineTarget(target),
  };
  const attemptId = randomUUID();
  const childName = `openclaw-stream-${attemptId}`;
  const custodyScope = createHash("sha256").update(prefix).digest("hex");
  const childId = retain(
    docker(
      "create",
      "--name",
      childName,
      "--network",
      "none",
      "--label",
      `openclaw.persistentExecAttempt=${attemptId}`,
      "--label",
      `openclaw.persistentExecParentId=${parentId}`,
      "--label",
      `openclaw.streamStore=${custodyScope}`,
      "--mount",
      `type=bind,source=${workspaceDir},target=/workspace`,
      "openclaw-sandbox:bookworm-slim",
      "true",
    ),
  );
  const receipt = {
    version: 1 as const,
    target,
    attemptId,
    parentContainerId: parentId,
    containerId: childId,
  };
  const { stopDockerPersistentExec, readDockerPersistentExecExtinctionProof } =
    await import("../../src/agents/sandbox/docker-persistent-exec.js");
  const stopped = await stopDockerPersistentExec(receipt, assertCurrent);
  assert.deepEqual(readDockerPersistentExecExtinctionProof(stopped.extinction), receipt);
  containers.delete(childId);
  fs.writeFileSync(
    path.join(output, "owned-containers.json"),
    JSON.stringify({ ids: [...containers], extinct: [childId] }, null, 2),
  );
  record = {
    ownerKey: "synthetic-stream",
    sourceIdentity: "synthetic-source",
    attemptId,
    backendId: "docker",
    backendTarget: target,
    containerId: parentId,
    containerName: parentName,
    containerStartedAt: docker("inspect", "--format", "{{.State.StartedAt}}", parentId),
    workspaceBinding: { workspaceDir, workspaceSource: "managed-worktree", registryCreatedAtMs: 1 },
    owner: {
      pid: process.pid,
      host: "synthetic",
      startedAt: 1,
      namespace: "synthetic",
      token: "synthetic",
    },
    revision: 1,
    phase: "stopped",
    error: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    receipt,
  };
  const { quiesceLocalWorkspace } =
    await import("../../src/agents/sandbox/local-workspace-quiescence.js");
  let retained: LocalWorkspacePausedRuntime[] = [];
  async function operation() {
    const custody = await quiesceLocalWorkspace({
      workspaceDir,
      retained,
      assertCurrent,
      persist: (next) => {
        retained = structuredClone(next);
        if (measuring) {
          writes++;
        }
      },
    });
    await custody.resume();
    assert.equal(retained.length, 0);
  }
  for (let warmup = 0; warmup < 5; warmup++) {
    await operation();
  }
  globalThis.gc?.();
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const hostLoad = loadavg(),
    before = process.threadCpuUsage(),
    started = performance.now();
  const times: number[] = [];
  loop.enable();
  gc.observe({ entryTypes: ["gc"] });
  measuring = true;
  for (let i = 0; i < iterations; i++) {
    const began = performance.now();
    await operation();
    times.push(performance.now() - began);
  }
  measuring = false;
  const elapsedMs = performance.now() - started,
    cpu = process.threadCpuUsage(before);
  const profile = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  loop.disable();
  gc.disconnect();
  assert.equal(
    docker("inspect", "--format", "{{.State.Running}} {{.State.Paused}}", parentId),
    "true false",
  );
  const allocation = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + allocation(child), 0);
  const keys = [...new Set(engineCalls.map((call) => `${call.target}.${call.operation}`))];
  const report = {
    boundary: "quiescence owner with in-memory registry/persistence fixtures and real Docker",
    revision: values.revision ?? "working-tree",
    sourceHash: createHash("sha256").update(ownerSource).digest("hex"),
    iterations,
    instrument: values.instrument,
    elapsedMs,
    hostLoad,
    hostLoadAfter: loadavg(),
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
    sampledAllocatedBytes: profile ? allocation(profile.profile.head) : null,
    sampledBytesPerOperation: profile ? allocation(profile.profile.head) / iterations : null,
    ownerLatency: stats(times),
    engineCalls: Object.fromEntries(
      keys.map((key) => {
        const calls = engineCalls.filter((call) => `${call.target}.${call.operation}` === key);
        return [
          key,
          {
            count: calls.length,
            perOperation: calls.length / iterations,
            latency: stats(calls.map((call) => call.ms)),
          },
        ];
      }),
    ),
    custodyChecks,
    persistenceWrites: writes,
    gcMs,
    gcMsPerMinute: (gcMs * 60_000) / elapsedMs,
    eventLoop: { samples: loop.count, p99Ms: loop.percentile(99) / 1e6 },
    memory: process.memoryUsage(),
    parentResumed: true,
    childExtinctionProven: true,
    notes: [
      "Main-thread CPU excludes Docker CLI/daemon CPU.",
      "In-memory persistence cost is not database cost.",
      "p99 below 1,000 samples is context only.",
    ],
  };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  failures.push(error);
} finally {
  const cleanup = async (run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };
  measuring = false;
  active = false;
  await cleanup(() => inspector?.disconnect());
  loop.disable();
  gc.disconnect();
  for (const id of containers) {
    await cleanup(() => docker("rm", "--force", id));
  }
  await cleanup(async () =>
    (await import("../../src/shared/global-singleton.js")).drainGlobalSingletonLifecycleState(),
  );
}
if (failures.length) {
  throw new AggregateError(failures, "Synthetic stopped-stream benchmark failed");
}
