// Loaded only by the isolated Gateway measurement; descendants must not allocate ballast.
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

const gatewayIndex = process.argv.indexOf("gateway");
if (
  isMainThread &&
  gatewayIndex >= 1 &&
  process.argv[gatewayIndex + 1] === "run" &&
  process.env.OPENCLAW_QA_TEMP_ROOT
) {
  const directory = process.env.OPENCLAW_RECONCILE_MEASURE_DIR;
  const ballastMiB = Number(process.env.OPENCLAW_RECONCILE_MEASURE_BALLAST_MIB);
  assert(directory && Number.isSafeInteger(ballastMiB) && ballastMiB >= 0);
  const ballastBytes = ballastMiB * 1024 ** 2;
  const ballast = Array.from({ length: 32 }, () => Buffer.alloc(ballastBytes / 32, 0x6d));
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const events = [];
  let scope;
  let start;
  const snapshot = () => ({
    time: performance.now(),
    at: Date.now(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    threadCpu: process.threadCpuUsage(),
  });
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    const begin = performance.now();
    try {
      return spawn.call(this, options);
    } finally {
      if (scope) {
        const executable = path.basename(String(options.file ?? ""));
        events.push({
          atMs: begin - start.time,
          ms: performance.now() - begin,
          executable,
          gitArgs: executable === "git" ? options.args : undefined,
        });
      }
    }
  };
  const server = createServer((request, response) => {
    const action = request.url?.slice(1);
    if (
      request.method !== "POST" ||
      !["dispatch", "changed-turn", "warm-changed-turn", "unchanged-turn", "end"].includes(action)
    ) {
      response.writeHead(400).end();
      return;
    }
    if (action !== "end") {
      if (scope) {
        response.writeHead(409).end();
        return;
      }
      // Retain and observe the touched buffers for the complete Gateway lifetime.
      assert.equal(
        ballast.reduce((sum, buffer) => sum + buffer.byteLength, 0),
        ballastBytes,
      );
      events.length = 0;
      delay.reset();
      scope = action;
      start = snapshot();
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ scope, pid: process.pid, rss: start.memory.rss }));
      return;
    }
    if (!scope) {
      response.writeHead(409).end();
      return;
    }
    const finish = snapshot();
    const git = events.filter((event) => event.executable === "git");
    const result = {
      captureMethod:
        "ChildProcess.prototype.spawn: async launches only; spawnSync/execFileSync excluded",
      scope,
      pid: process.pid,
      ballastBytes,
      startAt: start.at,
      endAt: finish.at,
      wallMs: finish.time - start.time,
      rssStart: start.memory.rss,
      rssEnd: finish.memory.rss,
      heapUsedDelta: finish.memory.heapUsed - start.memory.heapUsed,
      processCpuUserUs: finish.cpu.user - start.cpu.user,
      processCpuSystemUs: finish.cpu.system - start.cpu.system,
      mainThreadCpuUserUs: finish.threadCpu.user - start.threadCpu.user,
      mainThreadCpuSystemUs: finish.threadCpu.system - start.threadCpu.system,
      loopP50Ms: delay.percentile(50) / 1e6,
      loopP95Ms: delay.percentile(95) / 1e6,
      loopP99Ms: delay.percentile(99) / 1e6,
      loopMaxMs: delay.max / 1e6,
      nativeHostLaunches: events.length,
      nativeHostSpawnMs: events.reduce((sum, event) => sum + event.ms, 0),
      nativeGitLaunches: git.length,
      nativeGitSpawnMs: git.reduce((sum, event) => sum + event.ms, 0),
      events: events.splice(0),
    };
    appendFileSync(path.join(directory, "metrics.jsonl"), JSON.stringify(result) + "\n");
    scope = undefined;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  const address = server.address();
  assert(address && typeof address !== "string");
  writeFileSync(
    path.join(directory, "probe.json"),
    JSON.stringify({
      port: address.port,
      pid: process.pid,
      rss: process.memoryUsage().rss,
      ballastBytes,
    }) + "\n",
  );
}
