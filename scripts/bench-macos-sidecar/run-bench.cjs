"use strict";
const { WebSocketServer } = require(
  require.resolve("ws", { paths: [process.env.OPENCLAW_BENCH_REPO || process.cwd()] }),
);
const { spawn, execFile, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.RFC54_BENCH_ROOT || __dirname;
const executable = process.argv[2];
const label = process.argv[3] || "baseline";
const repetitions = Number(process.argv[4] || 5);
const count = Number(process.argv[5] || 2000);
const warmup = 100;
const extraArgs = JSON.parse(process.env.RFC54_BENCH_EXTRA_ARGS || "[]");
const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const resultsPath = path.join(root, `${label}-results.json`);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const quantile = (v, q) =>
  v.toSorted((a, b) => a - b)[Math.min(v.length - 1, Math.ceil(v.length * q) - 1)];
function parseUsage(pid, psOutput) {
  const rows = psOutput
    .trim()
    .split("\n")
    .map((line) => {
      const [id, parent, time, rss] = line.trim().split(/\s+/);
      const [min, sec] = time.split(":").map(Number);
      return {
        pid: Number(id),
        ppid: Number(parent),
        cpuSeconds: min * 60 + sec,
        rssKiB: Number(rss),
      };
    });
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  const selected = rows.filter((row) => ids.has(row.pid));
  return {
    processes: selected,
    cpuSeconds: selected.reduce((a, r) => a + r.cpuSeconds, 0),
    rssKiB: selected.reduce((a, r) => a + r.rssKiB, 0),
  };
}
function usage(pid) {
  return parseUsage(
    pid,
    execFileSync("/bin/ps", ["-axo", "pid=,ppid=,time=,rss="], { encoding: "utf8" }),
  );
}
async function run(repetition, bytes, concurrency) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024,
  });
  await once(server, "listening");
  let socket;
  let rejectPhase;
  let phase;
  let stderr = "";
  let stdout = "";
  const payload = { data: "x".repeat(bytes - 11) };
  const paramsJSON = JSON.stringify(payload);
  if (Buffer.byteLength(paramsJSON) !== bytes) {
    throw new Error("payload byte mismatch");
  }
  const handshake = {};
  server.on("connection", (ws) => {
    if (socket) {
      throw new Error("unexpected reconnect");
    }
    socket = ws;
    handshake.webSocketConnectedAt = now();
    ws.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "rfc54-benchmark-nonce", ts: Date.now() },
      }),
    );
    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw);
        if (frame.type !== "req") {
          throw new Error("unexpected Gateway frame");
        }
        if (frame.method === "connect") {
          handshake.connectRequestAt = now();
          handshake.connectProtocol = frame.params.maxProtocol;
          if (frame.params.auth?.token !== "benchmark-token") {
            throw new Error("missing test token");
          }
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: frame.params.maxProtocol,
                server: { version: "benchmark", connId: "benchmark" },
                features: {
                  methods: ["node.invoke.result"],
                  events: ["node.invoke.request"],
                  capabilities: [],
                },
                snapshot: {
                  presence: [{ ts: 1 }],
                  health: {},
                  stateVersion: { presence: 0, health: 0 },
                  uptimeMs: 0,
                },
                policy: { maxPayload: 16777216, maxBufferedBytes: 16777216, tickIntervalMs: 30000 },
                auth: { role: "node", scopes: [] },
              },
            }),
          );
          return;
        }
        if (frame.method !== "node.invoke.result") {
          throw new Error(`unexpected method ${frame.method}`);
        }
        const result = frame.params;
        if (!result.ok) {
          throw new Error("invocation failed: " + JSON.stringify(result.error));
        }
        const received =
          result.payloadJSON === undefined ? result.payload : JSON.parse(result.payloadJSON);
        if (JSON.stringify(received) !== paramsJSON) {
          throw new Error("echo payload corrupted");
        }
        const started = phase?.pending.get(result.id);
        if (started === undefined) {
          throw new Error("uncorrelated or duplicate result " + result.id);
        }
        phase.pending.delete(result.id);
        phase.latencies.push(now() - started);
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
        phase.completed++;
        if (phase.sent < phase.total) {
          phase.sendOne();
        }
        if (phase.completed === phase.total) {
          phase.resolve({ latenciesMs: phase.latencies, elapsedMs: now() - phase.start });
        }
      } catch (error) {
        rejectPhase?.(error);
        child.kill();
      }
    });
  });
  const spawnedAt = now();
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-D",
      `BENCH_ROOT=${fs.realpathSync(root)}`,
      "-D",
      `BENCH_ENDPOINT=localhost:${server.address().port}`,
      "-f",
      path.join(root, "sandbox.sb"),
      executable,
      `ws://127.0.0.1:${server.address().port}`,
      ...extraArgs,
    ],
    {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: path.join(root, "home"),
        CFFIXED_USER_HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp") + "/",
        LANG: "en_US.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stderr.on("data", (data) => (stderr += data));
  let ready;
  let result;
  const observed = new Set([child.pid]);
  const observe = () => {
    const value = usage(child.pid);
    for (const row of value.processes) {
      observed.add(row.pid);
    }
    return value;
  };
  let observerBusy = false;
  const startupObserver = setInterval(() => {
    if (observerBusy) {
      return;
    }
    observerBusy = true;
    execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,time=,rss="],
      { encoding: "utf8" },
      (error, psOutput) => {
        observerBusy = false;
        if (error) {
          return;
        }
        for (const row of parseUsage(child.pid, psOutput).processes) {
          observed.add(row.pid);
        }
      },
    );
  }, 50);
  const childExited = once(child, "exit");
  /** @type {Error | undefined} */
  let cleanupError;
  try {
    ready = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("startup timed out; " + stderr)), 15000);
      deadline.unref();
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        clearTimeout(deadline);
        if (!stdout.includes("\n")) {
          reject(new Error(`exited ${code}/${signal}: ${stderr}`));
        }
      });
      child.stdout.on("data", (data) => {
        stdout += data;
        const line = stdout.split("\n")[0];
        if (stdout.includes("\n")) {
          clearTimeout(deadline);
          try {
            resolve({ ...JSON.parse(line), processReadyMs: now() - spawnedAt });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    });
    clearInterval(startupObserver);
    observe();
    const forceSupervisorExit = process.env.RFC54_BENCH_FORCE_SUPERVISOR_EXIT === "1";
    if (forceSupervisorExit) {
      result = { scenario: "supervisor-killed-after-ready", ready };
      child.kill("SIGKILL");
      await childExited;
    } else {
      async function invoke(total, prefix) {
        return await new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error("invoke phase timed out")), 30000);
          rejectPhase = reject;
          phase = {
            total,
            sent: 0,
            completed: 0,
            pending: new Map(),
            latencies: [],
            start: now(),
            resolve: (r) => {
              clearTimeout(deadline);
              resolve(r);
            },
          };
          phase.sendOne = () => {
            const id = `${prefix}-${phase.sent++}`;
            const frame = {
              type: "event",
              event: "node.invoke.request",
              payload: {
                id,
                nodeId: "benchmark-node",
                command: "benchmark.echo",
                paramsJSON,
                timeoutMs: 30000,
                idempotencyKey: id,
              },
            };
            const wire = JSON.stringify(frame);
            phase.pending.set(id, now());
            socket.send(wire);
          };
          for (let i = 0; i < Math.min(concurrency, total); i++) {
            phase.sendOne();
          }
        });
      }
      await invoke(warmup, "warmup");
      const before = observe();
      const measured = await invoke(count, "measured");
      const after = observe();
      result = {
        repetition,
        payloadBytes: bytes,
        concurrency,
        count,
        warmup,
        ready,
        handshake: {
          challengeToConnectRequestMs: handshake.connectRequestAt - handshake.webSocketConnectedAt,
          protocol: handshake.connectProtocol,
        },
        p50Ms: quantile(measured.latenciesMs, 0.5),
        p95Ms: quantile(measured.latenciesMs, 0.95),
        p99Ms: quantile(measured.latenciesMs, 0.99),
        throughputPerSecond: count / (measured.elapsedMs / 1000),
        elapsedMs: measured.elapsedMs,
        cpuSeconds: Math.max(0, after.cpuSeconds - before.cpuSeconds),
        rssBeforeKiB: before.rssKiB,
        rssAfterKiB: after.rssKiB,
        processesBefore: before.processes,
        processesAfter: after.processes,
        latenciesMs: measured.latenciesMs,
        stderr,
      };
    }
  } finally {
    clearInterval(startupObserver);
    observe();
    child.stdin.end();
    await Promise.race([childExited, delay(3000)]);
    const forced = [];
    const live = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") {
          return false;
        }
        cleanupError ||= error;
        return false;
      }
    };
    if (child.exitCode === null && child.signalCode === null) {
      forced.push(child.pid);
      child.kill("SIGKILL");
      await childExited;
    }
    let remaining = [...observed].filter(live);
    for (let i = 0; remaining.length && i < 20; i++) {
      await delay(50);
      remaining = remaining.filter(live);
    }
    for (const pid of remaining) {
      forced.push(pid);
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH" && !cleanupError) {
          cleanupError = error;
        }
      }
    }
    for (let i = 0; remaining.length && i < 40; i++) {
      await delay(50);
      remaining = remaining.filter(live);
    }
    const cleanup = { observedPIDs: [...observed], forcedPIDs: forced, remainingPIDs: remaining };
    if (result) {
      result.cleanup = cleanup;
    }
    fs.appendFileSync(
      path.join(root, `${label}-cleanup.jsonl`),
      JSON.stringify({
        utc: new Date().toISOString(),
        repetition,
        bytes,
        concurrency,
        ...cleanup,
      }) + "\n",
    );
    for (const ws of server.clients) {
      ws.terminate();
    }
    await new Promise((resolve) => {
      server.close(resolve);
    });
    if ((remaining.length || forced.length) && !cleanupError) {
      cleanupError = new Error(
        "Owned process cleanup could not be verified: " + JSON.stringify(cleanup),
      );
    }
  }
  if (cleanupError) {
    throw cleanupError;
  }
  return result;
}
(async () => {
  const results = [];
  for (let r = 0; r < repetitions; r++) {
    for (const bytes of [256, 4096]) {
      for (const concurrency of [1, 8]) {
        const result = await run(r, bytes, concurrency);
        results.push(result);
        console.log(JSON.stringify({ ...result, latenciesMs: undefined, stderr: undefined }));
        fs.writeFileSync(
          resultsPath,
          JSON.stringify(
            {
              label,
              executable,
              extraArgs,
              utc: new Date().toISOString(),
              node: process.version,
              wsVersion: require(
                require.resolve("ws/package.json", {
                  paths: [process.env.OPENCLAW_BENCH_REPO || process.cwd()],
                }),
              ).version,
              methodology: {
                warmup,
                count,
                repetitions,
                server: "loopback ws mock Gateway",
                nativeHandler: "echo identical paramsJSON",
                network: "ws no TLS",
                authentication:
                  "test shared token; includeDeviceIdentity=false; allowStoredDeviceAuth=false; excludes Ed25519 signing and Keychain/SQLite credential I/O",
                resources:
                  "ps cumulative CPU and summed RSS for Swift harness and descendant sidecar; not full application; snapshots not peak",
              },
              results,
            },
            null,
            2,
          ),
        );
      }
    }
  }
})().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exitCode = 1;
});
