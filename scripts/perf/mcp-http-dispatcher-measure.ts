/**
 * Compare the actual MCP HTTP fetch owner against a separate-process loopback server.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/mcp-http-dispatcher-measure.ts \
 *   --base-ref <sha> --iterations 1000 --pairs 5 --output .local/mcp-http-measure
 * This snapshots only baseline mcp-http-fetch.ts; both arms use current dependencies.
 * It is an owner-module comparison, not whole-build or Gateway throughput proof.
 * Serial pairs alternate AB/BA, with allocation and untraced timing in separate workers.
 */
import assert from "node:assert/strict";
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { Session, type HeapProfiler } from "node:inspector/promises";
import type { Socket } from "node:net";
import { cpus, loadavg } from "node:os";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "../..");
const ownerPath = "src/agents/mcp-http-fetch.ts";
const requestBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const responseBody = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
const warmup = 20;
let stateDir = process.env.OPENCLAW_STATE_DIR;
const { values } = parseArgs({
  options: {
    "base-ref": { type: "string" },
    iterations: { type: "string", default: "1000" },
    pairs: { type: "string", default: "5" },
    output: { type: "string" },
    server: { type: "boolean" },
    worker: { type: "boolean" },
    owner: { type: "string" },
    phase: { type: "string" },
  },
});

function integer(value: string, name: string): number {
  const result = Number(value);
  assert(Number.isSafeInteger(result) && result > 0, `${name} must be a positive integer`);
  return result;
}

function child(args: string[]): ChildProcess {
  return fork(script, args, {
    cwd: root,
    execArgv: ["--expose-gc", "--import", path.join(root, "scripts/tsx.mjs")],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: {
      ...process.env,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      NO_PROXY: "*",
      no_proxy: "*",
      NODE_USE_ENV_PROXY: "0",
      OPENCLAW_DEBUG_PROXY_ENABLED: "false",
      OPENCLAW_PROXY_ACTIVE: "0",
      OPENCLAW_STATE_DIR: stateDir,
    },
  });
}

function message<T>(process: ChildProcess, command?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Benchmark child timed out")), 300_000);
    const onExit = () => finish(new Error("Benchmark child exited before reporting"));
    const onError = (error: Error) => finish(error);
    const onMessage = (result: T) => finish(undefined, result);
    function finish(error?: Error, result?: T) {
      clearTimeout(timer);
      process.off("exit", onExit).off("error", onError).off("message", onMessage);
      if (error) {
        reject(error);
      } else {
        resolve(result!);
      }
    }
    process.once("exit", onExit).once("error", onError).once("message", onMessage);
    if (command) {
      process.send(command);
    }
  });
}

async function stop(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }
  const exited = once(process, "exit");
  process.kill("SIGTERM");
  await exited;
}

async function serve() {
  let requests = 0;
  let connections = 0;
  let deliveredBytes = 0;
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 4096) {
        request.destroy();
      }
    });
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/mcp");
      assert.equal(body, requestBody);
      requests++;
      sockets.add(request.socket);
      deliveredBytes += Buffer.byteLength(responseBody);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(responseBody);
    });
  });
  server.on("connection", () => connections++);
  process.once("disconnect", () => process.exit(0));
  process.on("message", (command) => {
    if (command === "reset") {
      requests = connections = deliveredBytes = 0;
      sockets.clear();
    }
    process.send?.({ requests, connections, socketsUsed: sockets.size, deliveredBytes });
  });
  // Bind only a high loopback port; retry collisions without touching other listeners.
  for (let attempt = 0; ; attempt++) {
    try {
      server.listen(40_000 + Math.floor(Math.random() * 20_000), "127.0.0.1");
      await once(server, "listening");
      break;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EADDRINUSE") ||
        attempt >= 20
      ) {
        throw error;
      }
    }
  }
  const address = server.address();
  assert(address && typeof address === "object");
  process.send?.({ url: `http://127.0.0.1:${address.port}/mcp` });
}

function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, entry) => sum + sampledBytes(entry), 0);
}

async function measure() {
  assert(global.gc, "Run with --expose-gc");
  assert(values.owner && (values.phase === "timing" || values.phase === "allocation"));
  const iterations = integer(values.iterations, "--iterations");
  const { closeProviderTransportDispatcherPool } =
    await import("../../src/agents/provider-transport-dispatcher-pool.js");
  const server = child(["--server"]);
  const serverReady = message<{ url: string }>(server);
  const session = new Session();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  let gcMs = 0;
  let gcCount = 0;
  let gcMaxPauseMs = 0;
  const gcByKind = {
    minor: { count: 0, ms: 0, maxPauseMs: 0 },
    major: { count: 0, ms: 0, maxPauseMs: 0 },
    incremental: { count: 0, ms: 0, maxPauseMs: 0 },
    weakCallbacks: { count: 0, ms: 0, maxPauseMs: 0 },
    other: { count: 0, ms: 0, maxPauseMs: 0 },
  };
  const gcKindNames = new Map<number, keyof typeof gcByKind>([
    [constants.NODE_PERFORMANCE_GC_MINOR, "minor"],
    [constants.NODE_PERFORMANCE_GC_MAJOR, "major"],
    [constants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
    [constants.NODE_PERFORMANCE_GC_WEAKCB, "weakCallbacks"],
  ]);
  let started = Infinity;
  let ended = Infinity;
  const observer = new PerformanceObserver((batch) => {
    for (const entry of batch.getEntries()) {
      if (entry.startTime >= started && entry.startTime < ended) {
        gcMs += entry.duration;
        gcCount++;
        gcMaxPauseMs = Math.max(gcMaxPauseMs, entry.duration);
        // Node exposes GC detail, but its PerformanceEntry declaration omits it.
        const kind = (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind;
        const stats = gcByKind[gcKindNames.get(kind) ?? "other"];
        stats.count++;
        stats.ms += entry.duration;
        stats.maxPauseMs = Math.max(stats.maxPauseMs, entry.duration);
      }
    }
  });
  try {
    const { url } = await serverReady;
    const { buildMcpHttpFetch } = (await import(
      pathToFileURL(values.owner).href
    )) as typeof import("../../src/agents/mcp-http-fetch.js");
    const fetch = buildMcpHttpFetch({ resourceUrl: url, requestTimeoutMs: 30_000 });
    const invoke = async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.equal(text, responseBody);
      return Buffer.byteLength(text);
    };
    for (let index = 0; index < warmup; index++) {
      await invoke();
    }
    await message(server, "reset");
    global.gc();
    await nextTurn();
    observer.observe({ entryTypes: ["gc"] });
    loop.enable();
    if (values.phase === "allocation") {
      session.connect();
      await session.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoad = loadavg();
    const utilization = performance.eventLoopUtilization();
    const cpu = process.threadCpuUsage();
    started = performance.now();
    let deliveredBytes = 0;
    for (let index = 0; index < iterations; index++) {
      deliveredBytes += await invoke();
    }
    ended = performance.now();
    const used = process.threadCpuUsage(cpu);
    const eventLoop = performance.eventLoopUtilization(utilization);
    loop.disable();
    const profile =
      values.phase === "allocation"
        ? (await session.post("HeapProfiler.stopSampling")).profile
        : undefined;
    await nextTurn();
    const transport = await message<{
      requests: number;
      connections: number;
      socketsUsed: number;
      deliveredBytes: number;
    }>(server, "stats");
    assert.equal(transport.requests, iterations);
    assert.equal(transport.deliveredBytes, deliveredBytes);
    return {
      phase: values.phase,
      iterations,
      warmup,
      ...transport,
      hostLoad,
      hostLoadAfter: loadavg(),
      wallMs: ended - started,
      mainThreadCpuUsPerRequest:
        values.phase === "timing" ? (used.user + used.system) / iterations : undefined,
      sampledBytesPerRequest: profile ? sampledBytes(profile.head) / iterations : undefined,
      samplingInterval: profile ? 32768 : undefined,
      gcMs,
      gcCount,
      gcMsPerRequest: gcMs / iterations,
      gcMaxPauseMs,
      gcByKind,
      eventLoop,
      loopSamples: loop.count,
      loopDelayP95Ms: loop.count > 0 ? loop.percentile(95) / 1e6 : null,
      loopDelayMaxMs: loop.max / 1e6,
      memory: process.memoryUsage(),
    };
  } finally {
    observer.disconnect();
    loop.disable();
    session.disconnect();
    try {
      await closeProviderTransportDispatcherPool();
    } finally {
      await stop(server);
    }
  }
}

async function main() {
  assert(values["base-ref"] && values.output, "Required: --base-ref <sha> --output <dir>");
  const iterations = integer(values.iterations, "--iterations");
  const pairs = integer(values.pairs, "--pairs");
  const output = path.resolve(values.output);
  await mkdir(output, { recursive: true });
  const local = path.join(root, ".local");
  await mkdir(local, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const baseRef = git("rev-parse", "--verify", `${values["base-ref"]}^{commit}`);
  const baseline = git("show", `${baseRef}:${ownerPath}`);
  const candidate = await readFile(path.join(root, ownerPath), "utf8");
  const scratch = await mkdtemp(path.join(local, "mcp-http-owner-"));
  const hash = (source: string) => createHash("sha256").update(source).digest("hex");
  const owners = {
    baseline: path.join(scratch, "baseline.ts"),
    candidate: path.join(root, ownerPath),
  };
  const results: Array<Awaited<ReturnType<typeof measure>> & { pair: number; arm: string }> = [];
  try {
    stateDir ??= path.join(scratch, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      owners.baseline,
      baseline.replace(
        /from "(\.\.?\/[^"]+)"/g,
        (_match, relative: string) =>
          `from ${JSON.stringify(path.resolve(root, "src/agents", relative))}`,
      ),
    );
    for (let pair = 0; pair < pairs; pair++) {
      const order =
        pair % 2 === 0
          ? (["baseline", "candidate"] as const)
          : (["candidate", "baseline"] as const);
      for (const phase of ["timing", "allocation"]) {
        for (const arm of order) {
          assert.equal(
            await readFile(owners.candidate, "utf8"),
            candidate,
            "Candidate changed during measurement",
          );
          const worker = child([
            "--worker",
            "--owner",
            owners[arm],
            "--phase",
            phase,
            "--iterations",
            String(iterations),
          ]);
          try {
            const result = {
              ...(await message<Awaited<ReturnType<typeof measure>>>(worker)),
              pair: pair + 1,
              arm,
            };
            assert.equal(
              await readFile(owners.candidate, "utf8"),
              candidate,
              "Candidate changed during measurement",
            );
            results.push(result);
            await writeFile(
              path.join(output, `${pair + 1}-${phase}-${arm}.json`),
              JSON.stringify(result, null, 2) + "\n",
            );
            console.log(JSON.stringify(result));
          } finally {
            await stop(worker);
          }
        }
      }
    }
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify(
        {
          comparison: "owner-module-only; current shared dependencies in both arms",
          workload: "serial synthetic JSON-RPC POST tools/list; fully consumed JSON response",
          context:
            "fresh worker per arm/phase; separate HTTP process; no application AsyncLocalStorage frame; 20 warmup requests",
          baseRef,
          candidateHead: git("rev-parse", "HEAD"),
          baselineSha256: hash(baseline),
          candidateSha256: hash(candidate),
          node: process.version,
          cpuModel: cpus()[0]?.model,
          cpuCount: cpus().length,
          iterations,
          pairs,
          results,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (values.server) {
  await serve();
} else if (values.worker) {
  const disconnected = () => process.exit(1);
  process.once("disconnect", disconnected);
  const result = await measure();
  process.off("disconnect", disconnected);
  process.send?.(result, () => process.disconnect?.());
} else {
  await main();
}
