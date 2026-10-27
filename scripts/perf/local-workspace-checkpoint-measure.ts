/**
 * Canonical checkpoint contention through the real projection/store owner.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-checkpoint-measure.ts
 *   --output .local/checkpoint-candidate --mode owner --requests 2048 --burst 64
 * Add --revision <base-sha> to load the original owner/callers without changing
 * the checkout. Run fresh processes in AB/BA order; each owns synthetic state.
 * --mode gateway adds 10k session rows, 40 fixture plugins and 64 WebSocket
 * clients, then exercises sessions.files.list on the same managed workspace.
 * This is a focused source-Gateway reproduction, not the ten-minute dist stress
 * campaign. There are no model turns or operator/Team services in this workload.
 * Count lease acquisitions and manifest scans first; timing and main-thread
 * allocation include real storage dispatch. Every burst must have identical
 * results; a later guest write must be present after the next request.
 * --mode path exercises the file-reader checkpoint entry point. Add --absent
 * for a registered worktree without a projection; compare 1,024 serial polls
 * with --requests 1024 --burst 1, using --instrument allocation separately.
 * Lease broker counts also report a simulated idle minute at 16 serial polls.
 * The synthetic checkout uses a relative Git pointer and fixed file mtimes so
 * independently rooted fixtures return identical Files metadata.
 * --mode maintenance measures idle artifact sweeps through the real allocation
 * lease owner; --mode publication measures settled-workspace custody. Use
 * --lease-sources for a separate caller-stack census (never for timing).
 * --mode heartbeat retains one independent worker lease across the warm run;
 * each operation verifies and renews it. Acquisition and release are outside
 * its warm counts, as they are outside recurring heartbeat ticks.
 * Maintenance also holds this sibling lease so recurring sweeps share a warm
 * heartbeat carrier, as they do with other active owners on a busy Gateway.
 * --instrument retention samples memory after collecting the main isolate and
 * observed direct workers, outside timing/GC measurements. Use identical-code controls
 * to separate retained memory from different natural-GC/worker-idle schedules.
 * These modes report 16 operations per simulated minute, not production rates.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Worker } from "node:worker_threads";
import { transformSync } from "esbuild";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import type { LocalWorkspaceOwner } from "../../src/gateway/worker-environments/local-workspace-types.ts";
import type { DiagnosticEventInput } from "../../src/infra/diagnostic-events.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    revision: { type: "string" },
    mode: { type: "string", default: "owner" },
    requests: { type: "string", default: "2048" },
    burst: { type: "string", default: "64" },
    files: { type: "string", default: "1000" },
    port: { type: "string", default: "44984" },
    instrument: { type: "string", default: "timing" },
    absent: { type: "boolean", default: false },
    "lease-sources": { type: "boolean", default: false },
    worktrees: { type: "string", default: "64" },
  },
});
assert(
  values.output &&
    ["owner", "path", "gateway", "maintenance", "publication", "heartbeat"].includes(values.mode!),
);
assert(!values.absent || values.mode !== "owner");
const requests = Number(values.requests),
  burst = Number(values.burst),
  files = Number(values.files),
  port = Number(values.port),
  worktrees = Number(values.worktrees);
for (const value of [requests, burst, files, port, worktrees]) {
  assert(Number.isSafeInteger(value) && value > 0);
}
assert(port >= 40000 && port <= 65535);
assert(["timing", "allocation", "retention"].includes(values.instrument!));
const workers = new Set<Worker>();
const observeWorker = (worker: Worker) => {
  workers.add(worker);
  worker.once("exit", () => workers.delete(worker));
};
if (values.instrument === "retention") {
  assert(globalThis.gc, "Retention samples require --expose-gc");
  process.on("worker", observeWorker);
}
if (values["lease-sources"]) {
  Error.stackTraceLimit = 32;
}
const output = path.resolve(values.output);
fs.mkdirSync(output);
for (const name of ["home", "tmp", "repo"]) {
  fs.mkdirSync(path.join(output, name));
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const owners = [
  "src/gateway/worker-environments/local-workspace-projection.ts",
  "src/agents/sandbox/local-workspace.ts",
  "src/gateway/server-methods/sessions-files.ts",
  "src/agents/worktrees/gc-artifacts.ts",
];
const source = new Map(
  owners.map((file) => [
    file,
    values.revision
      ? execFileSync("git", ["show", `${values.revision}:${file}`], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
        })
      : fs.readFileSync(path.join(root, file), "utf8"),
  ]),
);
let acquisitions = 0,
  scans = 0;
const leaseSources = new Map<string, { scope: string; stack: string; calls: number }>();
Object.assign(globalThis, {
  __leaseSourceMeasure: (scope: string, stack: string) => {
    const key = JSON.stringify([scope, stack]);
    const entry = leaseSources.get(key) ?? {
      scope,
      stack: stack.replaceAll(root, "<source>"),
      calls: 0,
    };
    entry.calls++;
    leaseSources.set(key, entry);
  },
  __checkpointMeasure: (action?: string) => {
    if (action === "scan") {
      scans++;
    } else if (action === undefined) {
      acquisitions++;
    }
  },
});
registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(root, fileURLToPath(url)) : "";
    let code = source.get(relative);
    if (values["lease-sources"] && relative === "src/state/openclaw-state-lease.ts") {
      code = fs.readFileSync(path.join(root, relative), "utf8");
      const anchor = "const validated = validateOpenClawStateLeaseOptions(invocation.options);";
      assert(code.includes(anchor));
      code = code.replace(
        anchor,
        anchor + "\nglobalThis.__leaseSourceMeasure(invocation.options.scope, new Error().stack);",
      );
    }
    if (relative === "src/gateway/worker-environments/local-workspace-store.ts") {
      code = fs.readFileSync(path.join(root, relative), "utf8");
      const anchor =
        'const readManifest: LocalWorkspaceStore["manifest"] = async (previous, action) => {';
      assert(code.includes(anchor));
      code = code.replace(
        "const env = params.env ?? process.env;",
        "globalThis.__checkpointMeasure();\nconst env = params.env ?? process.env;",
      );
      code = code.replace(anchor, anchor + "\nglobalThis.__checkpointMeasure(action.kind);");
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
const configPath = path.join(output, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    TMPDIR: path.join(output, "tmp"),
    OPENCLAW_SKIP_CHANNELS: "1",
    DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  },
});
const repo = path.join(output, "repo"),
  canonical = path.join(output, "canonical");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: process.env, encoding: "utf8" });
git("init", "--quiet", "-b", "main");
git("config", "user.name", "Synthetic fixture");
git("config", "user.email", "fixture@example.invalid");
for (let i = 0; i < files; i++) {
  fs.writeFileSync(path.join(repo, `file-${i}.txt`), `synthetic ${i}\n`);
}
git("add", ".");
git("commit", "--quiet", "-m", "Synthetic workspace");
git("worktree", "add", "--quiet", "-b", "fixture", canonical);
if (values.mode === "gateway") {
  const pointerPath = path.join(canonical, ".git");
  const pointer = fs.readFileSync(pointerPath, "utf8");
  assert(pointer.startsWith("gitdir: "));
  fs.writeFileSync(pointerPath, `gitdir: ${path.relative(canonical, pointer.slice(8).trim())}\n`);
}
const plugins = values.mode === "gateway" ? writePluginFixtures(output, { count: 40 }) : undefined;
const config: OpenClawConfig = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  worktreeAcceleration: false,
  gateway: {
    ...BASE_GATEWAY_BENCH_CONFIG.gateway,
    controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
  },
  agents: { entries: { main: { workspace: repo } } },
  cron: { enabled: false },
  plugins: {
    enabled: true,
    allow: plugins?.pluginIds ?? [],
    load: { paths: plugins ? [plugins.pluginsDir] : [] },
    slots: { memory: "none" },
  },
};
fs.writeFileSync(configPath, JSON.stringify(config));
const sessionKey = "agent:main:dashboard:checkpoint-fixture";
const owner: LocalWorkspaceOwner = {
  agentId: "main",
  sessionKey,
  sessionId: "checkpoint-fixture",
  lifecycleRevision: null,
  assertCurrent() {},
  env: process.env,
  worktree: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "fixture",
    repoFingerprint: "fixture",
    repoRoot: repo,
    path: canonical,
    branch: "fixture",
    baseRef: "main",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  },
};
const projection =
  await import("../../src/gateway/worker-environments/local-workspace-projection.js");
const state = await import("../../src/state/openclaw-state-db.js");
const agent = await import("../../src/state/openclaw-agent-db.js");
(await import("../../src/config/runtime-snapshot.js")).setRuntimeConfigSnapshot(config);
state.openOpenClawStateDatabase();
if (values.mode !== "maintenance") {
  await (
    await import("../../src/agents/worktrees/registry.js")
  ).insertRegistryWorktree(process.env, owner.worktree);
}
const workspace =
  values.absent || values.mode === "maintenance" || values.mode === "heartbeat"
    ? undefined
    : await projection.withLocalWorkspaceProjection(owner, (operations) => operations.prepare());
for (const directory of workspace ? [canonical, workspace] : [canonical]) {
  for (let i = 0; i < files; i++) {
    fs.utimesSync(path.join(directory, `file-${i}.txt`), 1_767_225_600, 1_767_225_600);
  }
}
if (values.mode === "gateway") {
  fs.utimesSync(path.join(canonical, ".git"), 1_767_225_600, 1_767_225_600);
}
const checkpoint = () =>
  values.mode === "path"
    ? projection.checkpointLocalWorkspacePath({ cwd: canonical })
    : values.revision
      ? projection.withLocalWorkspaceProjection(owner, (operations) =>
          operations.synchronize("canonical"),
        )
      : projection.checkpointLocalWorkspace(owner);
const { collectRetiredWorktreeArtifacts } =
  await import("../../src/agents/worktrees/gc-artifacts.js");
const { WorktreeGcProgress } = await import("../../src/agents/worktrees/gc-progress.js");
const { withWorktreeAllocationLease } = await import("../../src/agents/worktrees/allocation.js");
// A populated default root with only registered checkouts is the recurring idle case.
const maintained: LocalWorkspaceOwner["worktree"][] = [];
if (values.mode === "maintenance") {
  const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
  for (let i = 0; i < worktrees; i++) {
    const record = {
      ...owner.worktree,
      id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
      path: path.join(
        process.env.OPENCLAW_STATE_DIR!,
        "worktrees",
        `repo-${i % 8}`,
        `registered-${i}`,
      ),
    };
    fs.mkdirSync(record.path, { recursive: true });
    await insertRegistryWorktree(process.env, record);
    maintained.push(record);
  }
}
let server:
  | Awaited<ReturnType<typeof import("../../src/gateway/server.js").startGatewayServer>>
  | undefined;
const clients: Array<import("../../src/gateway/client.js").GatewayClient> = [];
const handlerDurations: number[] = [];
let stopRpcDiagnostics = () => {};
let stopLeaseDiagnostics = () => {};
const endHeartbeat = Promise.withResolvers<void>();
let heartbeatDone: Promise<void> | undefined;
let heartbeatLease:
  | import("../../src/state/openclaw-state-lease.js").OpenClawStateAsyncLeaseContext
  | undefined;
try {
  if (values.mode === "heartbeat" || values.mode === "maintenance") {
    const ready = Promise.withResolvers<NonNullable<typeof heartbeatLease>>();
    const { withOpenClawStateLeaseAsync } = await import("../../src/state/openclaw-state-lease.js");
    const { captureOpenClawStateWorkerContext } =
      await import("../../src/state/openclaw-state-worker-context.js");
    heartbeatDone = withOpenClawStateLeaseAsync(
      {
        scope: "synthetic.heartbeat",
        key: "held",
        leaseMs: 600_000,
        waitMs: 0,
        heartbeat: "worker",
      },
      captureOpenClawStateWorkerContext(),
      async (lease) => {
        ready.resolve(lease);
        await endHeartbeat.promise;
      },
    );
    void heartbeatDone.catch(ready.reject);
    heartbeatLease = await ready.promise;
  }
  if (values.mode === "gateway") {
    const db = agent.openOpenClawAgentDatabase({ agentId: "main" });
    const { writeSessionEntry } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
    agent.runOpenClawAgentWriteTransaction(
      (writer) => {
        for (let i = 0; i < 10_000; i++) {
          writeSessionEntry(writer, `agent:main:subagent:fixture-${i}`, {
            sessionId: `fixture-${i}`,
            updatedAt: 1,
            label: `Synthetic ${i}`,
          });
        }
        writeSessionEntry(writer, sessionKey, {
          sessionId: owner.sessionId,
          updatedAt: 1,
          spawnedCwd: canonical,
          worktree: { id: owner.worktree.id, branch: owner.worktree.branch, repoRoot: repo },
        });
      },
      { agentId: "main", path: db.path },
    );
    await agent.closeOpenClawAgentDatabasesAsync();
    await state.closeOpenClawStateDatabaseAsync();
    server = await (
      await import("../../src/gateway/server.js")
    ).startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
    const { GatewayClient } = await import("../../src/gateway/client.js");
    for (let i = 0; i < burst; i++) {
      const ready = Promise.withResolvers<void>();
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        clientName: "openclaw-control-ui",
        mode: "webchat",
        platform: "web",
        instanceId: `checkpoint-${i}`,
        scopes: ["operator.admin"],
        requestTimeoutMs: 600_000,
        onHelloOk: () => ready.resolve(),
        onConnectError: (error) => ready.reject(error),
      });
      clients.push(client);
      client.start();
      await ready.promise;
    }
  }
  const sweep = async () => {
    const progress = new WorktreeGcProgress();
    const result = await collectRetiredWorktreeArtifacts({
      env: process.env,
      records: maintained,
      expiresBefore: 0,
      progress,
      orphanFailures: new Map(),
      withAllocationLease: (run) => withWorktreeAllocationLease({ env: process.env }, run),
    });
    assert.equal(
      progress.result.outcome,
      "completed",
      "A failed sweep is not a performance sample",
    );
    assert.equal(progress.result.issueCount, 0);
    assert.deepEqual(result, { orphansDeleted: 0, snapshotsPruned: 0 });
    return result;
  };
  const runOne = (i: number) =>
    values.mode === "gateway"
      ? clients[i % clients.length]!.request("sessions.files.list", { sessionKey })
      : values.mode === "maintenance"
        ? sweep()
        : values.mode === "publication"
          ? projection.withSettledLocalWorkspace(
              { worktree: owner.worktree, env: process.env },
              async () => {},
            )
          : values.mode === "heartbeat"
            ? heartbeatLease!.assertOwned().then(() => heartbeatLease!.renew())
            : checkpoint();
  await runOne(0);
  if (values.mode === "gateway") {
    const rpcDiagnostics = channel("openclaw.gateway.rpc");
    const observeHandler = (message: unknown) => {
      // This native channel publishes the Gateway diagnostic owner's event contract.
      const event = message as Extract<DiagnosticEventInput, { type: "gateway.rpc" }>;
      if (event.phase === "handler" && event.method === "sessions.files.list") {
        handlerDurations.push(event.durationMs);
      }
    };
    rpcDiagnostics.subscribe(observeHandler);
    stopRpcDiagnostics = () => {
      rpcDiagnostics.unsubscribe(observeHandler);
    };
  }
  const initial = fs.readFileSync(path.join(canonical, "file-0.txt"), "utf8");
  assert.equal(initial, "synthetic 0\n");
  acquisitions = 0;
  scans = 0;
  leaseSources.clear();
  const { onInternalDiagnosticEvent, waitForDiagnosticEventsDrained } =
    await import("../../src/infra/diagnostic-events.js");
  await waitForDiagnosticEventsDrained();
  const leaseRequests: Record<string, number> = {};
  stopLeaseDiagnostics = onInternalDiagnosticEvent(
    (event) => {
      if (
        event.type === "worker.request" &&
        event.phase === "completed" &&
        event.requestClass.startsWith("stateLease.")
      ) {
        leaseRequests[event.requestClass] = (leaseRequests[event.requestClass] ?? 0) + 1;
      }
    },
    { include: ["worker.request"] },
  );
  globalThis.gc?.();
  const inspector = values.instrument === "allocation" ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let gcMs = 0;
  const gcByKind: Record<string, { count: number; ms: number; maxMs: number }> = {};
  const observer = new PerformanceObserver((events) => {
    for (const entry of events.getEntries()) {
      gcMs += entry.duration;
      if (
        "detail" in entry &&
        typeof entry.detail === "object" &&
        entry.detail !== null &&
        "kind" in entry.detail
      ) {
        const summary = (gcByKind[String(entry.detail.kind)] ??= { count: 0, ms: 0, maxMs: 0 });
        summary.count++;
        summary.ms += entry.duration;
        summary.maxMs = Math.max(summary.maxMs, entry.duration);
      }
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const hostLoad = loadavg(),
    before = process.threadCpuUsage(),
    start = performance.now();
  const latencies: number[] = [];
  let resultHash: string | undefined;
  let semanticResultHash: string | undefined;
  let representativeResult: unknown;
  for (let offset = 0; offset < requests; offset += burst) {
    await Promise.all(
      Array.from({ length: Math.min(burst, requests - offset) }, async (_, i) => {
        const begin = performance.now(),
          result = await runOne(i);
        latencies.push(performance.now() - begin);
        if (values.mode === "gateway") {
          representativeResult ??= result;
          const hash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
          resultHash ??= hash;
          assert.equal(hash, resultHash, "Concurrent readers must return identical lists");
          semanticResultHash ??= createHash("sha256")
            .update(
              JSON.stringify(result, (_key, value: unknown) =>
                typeof value === "string" ? value.replaceAll(output, "<fixture>") : value,
              ),
            )
            .digest("hex");
        }
      }),
    );
  }
  const elapsedMs = performance.now() - start,
    cpu = process.threadCpuUsage(before);
  await waitForDiagnosticEventsDrained();
  stopLeaseDiagnostics();
  stopRpcDiagnostics();
  if (values.mode === "gateway") {
    assert.equal(handlerDurations.length, requests, "Every measured RPC needs a handler sample");
  }
  const profile = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  loop.disable();
  observer.disconnect();
  const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
  const sampledBytes = profile ? allocated(profile.profile.head) : undefined;
  latencies.sort((a, b) => a - b);
  handlerDurations.sort((a, b) => a - b);
  const report = {
    mode: values.mode,
    revision: values.revision ?? "candidate",
    instrument: values.instrument,
    requests,
    burst,
    files,
    worktrees: maintained.length,
    sources: Object.fromEntries(
      [...source].map(([file, code]) => [file, createHash("sha256").update(code).digest("hex")]),
    ),
    hostLoad,
    hostLoadAfter: loadavg(),
    acquisitions,
    scans,
    absentProjection: workspace === undefined,
    leaseRequests,
    leaseSources: [...leaseSources.values()].map(({ scope, stack, calls }) => ({
      scope,
      stack,
      calls,
    })),
    leaseRequestsPerSimulatedIdleMinute:
      (Object.values(leaseRequests).reduce((sum, count) => sum + count, 0) * 16) / requests,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuPercent: (cpu.user + cpu.system) / (elapsedMs * 10),
    cpuUsPerRequest: (cpu.user + cpu.system) / requests,
    sampledBytesPerRequest: sampledBytes === undefined ? null : sampledBytes / requests,
    sampledBytesPerSecond: sampledBytes === undefined ? null : (sampledBytes * 1000) / elapsedMs,
    eventLoopP99Ms: loop.percentile(99) / 1e6,
    eventLoopSamples: loop.count,
    requestP99Ms: latencies[Math.floor((latencies.length - 1) * 0.99)],
    ...(values.mode === "gateway"
      ? {
          serverHandlerSamples: handlerDurations.length,
          serverHandlerP99Ms: handlerDurations[Math.floor((handlerDurations.length - 1) * 0.99)],
        }
      : {}),
    gcMs,
    gcByKind,
    gcMsPerMinute: (gcMs * 60_000) / elapsedMs,
    memory: process.memoryUsage(),
    resultHash,
    semanticResultHash,
  };
  if (representativeResult !== undefined) {
    fs.writeFileSync(
      path.join(output, "response.json"),
      JSON.stringify(representativeResult, null, 2),
    );
  }
  for (const record of maintained) {
    assert(
      fs.statSync(record.path).isDirectory(),
      "Maintenance must preserve registered checkouts",
    );
  }
  if (workspace) {
    fs.writeFileSync(path.join(workspace, "file-0.txt"), "fresh later guest write\n");
    await runOne(0);
    assert.equal(
      fs.readFileSync(path.join(canonical, "file-0.txt"), "utf8"),
      "fresh later guest write\n",
    );
  } else {
    assert.equal(fs.readFileSync(path.join(canonical, "file-0.txt"), "utf8"), initial);
  }
  let retainedMemory;
  if (values.instrument === "retention") {
    const heaps = [];
    for (const worker of workers) {
      const workerProfile = await worker.startHeapProfile({ forceGC: true });
      await workerProfile.stop();
      heaps.push(await worker.getHeapStatistics());
    }
    globalThis.gc!();
    retainedMemory = { ...process.memoryUsage(), workerHeaps: heaps };
  }
  const verified = {
    ...report,
    retainedMemory,
    freshness: workspace ? "passed" : "absent projection unchanged",
  };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(verified, null, 2));
  console.log(JSON.stringify(verified));
} finally {
  stopRpcDiagnostics();
  stopLeaseDiagnostics();
  for (const client of clients) {
    client.stop();
  }
  endHeartbeat.resolve();
  await heartbeatDone;
  process.off("worker", observeWorker);
  await server?.close({ reason: "synthetic checkpoint measurement complete" });
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
  await (await import("../../src/shared/global-singleton.js")).drainGlobalSingletonLifecycleState();
}
