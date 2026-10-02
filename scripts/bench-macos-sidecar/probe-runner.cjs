const { WebSocketServer } = require(
  require.resolve("ws", { paths: [process.env.OPENCLAW_BENCH_REPO || process.cwd()] }),
);
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const crypto = require("node:crypto");
const root = process.env.RFC54_BENCH_ROOT || __dirname;
const kind = process.argv[2] || "aux";
const mode = process.argv[3] || root + "/bin/openclaw-mac-node-sidecar";
const label = process.argv[4] || kind + "-probe";
const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const fixtureDir = root + "/tls-fixtures";
function descendantPIDs(pid) {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((x) => x.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]);
  for (let i = 0; i < 5; i++) {
    for (const [id, parent] of rows) {
      if (ids.has(parent)) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}
async function run(pinMode) {
  let httpServer;
  let pin;
  let observedPin;
  let upgradeCount = 0;
  let connectCount = 0;
  let floodEventsQueued = 0;
  const batchCounts = new Map();
  const echoedBatches = [];
  const nativeCapacity = { progress: false, result: false };
  const timers = [];
  const framingBytes = [];
  if (kind === "tls") {
    const der = fs.readFileSync(fixtureDir + "/localhost.der");
    observedPin = crypto.createHash("sha256").update(der).digest("hex");
    pin = pinMode === "match" ? observedPin : "00".repeat(32);
    const cert = new crypto.X509Certificate(der).toString();
    const key = crypto
      .createPrivateKey({
        key: fs.readFileSync(fixtureDir + "/localhost-key.der"),
        format: "der",
        type: "pkcs8",
      })
      .export({ format: "pem", type: "pkcs8" });
    httpServer = https.createServer({ key, cert });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    httpServer.on("upgrade", () => upgradeCount++);
  }
  const server = new WebSocketServer(
    httpServer
      ? { server: httpServer, perMessageDeflate: false }
      : { host: "127.0.0.1", port: 0, perMessageDeflate: false },
  );
  if (!httpServer) {
    await once(server, "listening");
  }
  const port = (httpServer || server).address().port;
  server.on("connection", (ws) => {
    if (kind === "framing" || kind === "startup" || kind === "writer-overflow") {
      connectCount++;
      ws.on("message", (raw, binary) => {
        framingBytes.push({ binary, hex: raw.toString("hex") });
        ws.send(JSON.stringify({ fixtureServerReceipt: true }));
      });
      return;
    }
    ws.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "probe-nonce", ts: Date.now() },
      }),
    );
    ws.on("message", (raw) => {
      const f = JSON.parse(raw);
      const reply = (payload) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload }));
        }
      };
      if (f.method === "connect") {
        connectCount++;
        reply({
          type: "hello-ok",
          protocol: f.params.maxProtocol,
          server: { version: "fixture", connId: "probe" },
          features: {
            methods: ["benchmark.delay", "benchmark.never", "benchmark.echo"],
            events: ["benchmark.batch-ready"],
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
        });
        if (kind !== "backpressure") {
          ws.send(
            JSON.stringify({
              type: "event",
              event: "benchmark.post-hello",
              payload: { immediate: true },
            }),
          );
        }
      } else if (f.method === "benchmark.flood") {
        reply({});
        for (let seq = 0; seq < 512; seq++) {
          floodEventsQueued++;
          ws.send(
            JSON.stringify({
              type: "event",
              event: "benchmark.input",
              payload: { seq, data: "x".repeat(15000) },
            }),
          );
        }
      } else if (f.method === "benchmark.delay") {
        timers.push(setTimeout(() => reply({ delayed: true }), f.params.delayMs));
      } else if (f.method === "benchmark.never") {
        if (f.params?.batch !== undefined) {
          const batch = f.params.batch;
          const count = (batchCounts.get(batch) || 0) + 1;
          batchCounts.set(batch, count);
          if (count === 64 && batch === 2) {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "node.invoke.request",
                payload: {
                  id: "native-capacity",
                  nodeId: "probe-node",
                  command: "benchmark.echo",
                  timeoutMs: 10000,
                },
              }),
            );
          } else if (count === 64) {
            ws.send(
              JSON.stringify({ type: "event", event: "benchmark.batch-ready", payload: { batch } }),
            );
          }
        }
      } else if (f.method === "node.invoke.progress" && f.params.invokeId === "native-capacity") {
        nativeCapacity.progress = f.params.chunk === "native-under-load";
        reply({});
      } else if (f.method === "node.invoke.result" && f.params.id === "native-capacity") {
        nativeCapacity.result = f.params.ok === true && nativeCapacity.progress;
        reply({});
        ws.send(
          JSON.stringify({ type: "event", event: "benchmark.batch-ready", payload: { batch: 2 } }),
        );
      } else {
        if (f.method === "benchmark.echo") {
          echoedBatches.push(f.params?.batch);
        }
        reply(f.params || {});
      }
    });
  });
  const name =
    kind === "startup"
      ? "startup-probe"
      : kind === "framing"
        ? "framing-probe"
        : kind === "tls"
          ? "tls-probe"
          : kind === "backpressure" || kind === "writer-overflow"
            ? "backpressure-probe"
            : mode === "baseline"
              ? "auxiliary-baseline"
              : "auxiliary-probe";
  const url = `${kind === "tls" ? "wss" : "ws"}://127.0.0.1:${port}`;
  const started = performance.now();
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-D",
      `BENCH_ROOT=${fs.realpathSync(root)}`,
      "-D",
      `BENCH_ENDPOINT=localhost:${port}`,
      "-f",
      root + "/sandbox.sb",
      root + "/bin/" + name,
      url,
      kind === "framing" || kind === "startup" || kind === "writer-overflow"
        ? root + "/bin/framing-helper-" + pinMode
        : mode,
      ...(kind === "writer-overflow" ? ["writer-overflow"] : []),
      ...(pin ? [pin, ...(process.env.RFC54_EMPTY_MANIFEST === "1" ? ["empty"] : [])] : []),
      ...(process.env.RFC54_CAPACITY_ONLY === "1"
        ? ["capacity", process.env.RFC54_CAPACITY_BATCHES || "10"]
        : []),
    ],
    {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root + "/home",
        CFFIXED_USER_HOME: root + "/home",
        TMPDIR: root + "/tmp/",
        LANG: "en_US.UTF-8",
      },
    },
  );
  const owned = new Set([child.pid]);
  let stdout = "",
    stderr = "";
  let startupChildPIDs = [];
  let connectionsBeforeActivation = 0;
  const observeStartup = () => {
    if (
      (kind !== "startup" && kind !== "writer-overflow") ||
      (kind === "writer-overflow" && connectCount !== 1) ||
      startupChildPIDs.length !== 0 ||
      (!stdout.includes('"prepared":true') && !stdout.includes('"preparing":true'))
    ) {
      return;
    }
    const descendants = descendantPIDs(child.pid).filter((pid) => pid !== child.pid);
    if (descendants.length === 0) {
      return;
    }
    startupChildPIDs = descendants;
    connectionsBeforeActivation = connectCount;
    for (const pid of startupChildPIDs) {
      owned.add(pid);
    }
    child.stdin.write(Buffer.from([1]));
  };
  child.stdout.on("data", (d) => {
    stdout += d;
    observeStartup();
  });
  child.stderr.on("data", (d) => (stderr += d));
  const monitor = setInterval(() => {
    observeStartup();
    for (const pid of descendantPIDs(child.pid)) {
      owned.add(pid);
    }
  }, 250);
  const exit = once(child, "exit");
  let result;
  /** @type {Error | undefined} */
  let cleanupError;
  try {
    const ended = await Promise.race([
      exit,
      delay(kind === "aux" ? 75000 : kind === "framing" || kind === "startup" ? 18000 : 15000).then(
        () => null,
      ),
    ]);
    if (!ended) {
      throw new Error("probe deadline expired");
    }
    const rows = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
    result = rows.at(-1);
    if (!result) {
      throw new Error("no result: " + stderr);
    }
    if (kind === "startup") {
      const expectedConnections =
        pinMode === "startup-reconnect"
          ? 2
          : ["startup-delayed", "startup-claimed"].includes(pinMode)
            ? 1
            : 0;
      const expectedBytes = Array.from({ length: expectedConnections }, () => ({
        binary: true,
        hex: Buffer.from("trigger").toString("hex"),
      }));
      if (
        ended[0] !== 0 ||
        ended[1] !== null ||
        !result.passed ||
        connectionsBeforeActivation !== 0 ||
        connectCount !== expectedConnections ||
        JSON.stringify(framingBytes) !== JSON.stringify(expectedBytes) ||
        startupChildPIDs.length !== 1 ||
        (expectedConnections > 0 &&
          (result.helperPIDs?.length !== expectedConnections ||
            result.helperPIDs[0] !== startupChildPIDs[0])) ||
        (expectedConnections === 2 && new Set(result.helperPIDs).size !== 2) ||
        (pinMode === "startup-delayed" && !result.waitedOverBootstrapBudget)
      ) {
        throw new Error(
          "startup ownership failed: " +
            JSON.stringify({ result, startupChildPIDs, connectCount, framingBytes }),
        );
      }
    }
    if (kind === "writer-overflow") {
      const expectedBytes = [{ binary: true, hex: Buffer.from("trigger").toString("hex") }];
      if (
        ended[0] !== 0 ||
        ended[1] !== null ||
        !result.passed ||
        !result.writerRetiredBeforeEightSeconds ||
        !result.authenticatedFreshChildRecovered ||
        result.sendErrors?.length !== 6 ||
        !result.sendErrors.every((code) => code === -1103) ||
        result.helperPIDs?.length !== 2 ||
        new Set(result.helperPIDs).size !== 2 ||
        startupChildPIDs.length !== 1 ||
        result.helperPIDs[0] !== startupChildPIDs[0] ||
        connectCount !== 2 ||
        JSON.stringify(framingBytes) !== JSON.stringify(expectedBytes)
      ) {
        throw new Error("authenticated writer overflow/recovery failed: " + JSON.stringify(result));
      }
    }
    if (kind === "framing") {
      const shouldDeliver = ["idle-after-control", "within-budget"].includes(pinMode);
      const elapsedSeconds = (performance.now() - started) / 1000;
      const minimumSeconds = pinMode === "idle-after-control" ? 11.5 : 7.5;
      const delivered =
        result.fixtureAck === 1 &&
        result.receiptCount === 1 &&
        result.ok === true &&
        elapsedSeconds >= minimumSeconds;
      const timedOut =
        result.failureDomain === "NSURLErrorDomain" &&
        result.failureCode === -1001 &&
        result.elapsedSeconds >= 9.5 &&
        result.elapsedSeconds < 13;
      const expectedBytes = shouldDeliver
        ? [{ binary: true, hex: Buffer.from("trigger").toString("hex") }]
        : [];
      if (
        ended[0] !== 0 ||
        ended[1] !== null ||
        connectCount !== 1 ||
        JSON.stringify(framingBytes) !== JSON.stringify(expectedBytes) ||
        (shouldDeliver ? !delivered : !timedOut)
      ) {
        throw new Error(
          "whole-frame deadline failed: " + JSON.stringify({ result, framingBytes, connectCount }),
        );
      }
      result.passed = true;
      result.probeElapsedSeconds = elapsedSeconds;
    }
    if (
      kind === "backpressure" &&
      (!result.passed || connectCount !== 2 || floodEventsQueued !== 512)
    ) {
      throw new Error("blocked-consumer retirement/recovery failed: " + JSON.stringify(result));
    }
    if (kind === "aux" && batchCounts.has(2) && !nativeCapacity.result) {
      throw new Error("native progress/result failed while application RPC capacity was full");
    }
    if (kind === "aux" && (!result.passed || connectCount !== 1)) {
      throw new Error("auxiliary probe failed: " + JSON.stringify(result));
    }
    if (
      kind === "tls" &&
      pinMode === "match" &&
      (!result.connected || result.effectiveFingerprint !== observedPin || connectCount !== 1)
    ) {
      throw new Error("matching-pin connection failed: " + JSON.stringify(result));
    }
    if (
      kind === "tls" &&
      pinMode === "mismatch" &&
      (result.connected ||
        !result.typedTLSFailure ||
        result.kind !== "pinMismatch" ||
        result.observedFingerprint !== observedPin ||
        result.systemTrustOk !== false ||
        upgradeCount !== 0 ||
        connectCount !== 0)
    ) {
      throw new Error(
        "mismatched-pin isolation failed: " +
          JSON.stringify({ result, upgradeCount, connectCount }),
      );
    }
  } catch (error) {
    result = { ...result, probeFailure: error.message };
    throw error;
  } finally {
    clearInterval(monitor);
    for (const pid of descendantPIDs(child.pid)) {
      owned.add(pid);
    }
    const live = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let remaining = [...owned].filter(live);
    const forced = [];
    for (let i = 0; i < 40 && remaining.length; i++) {
      await delay(25);
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
    for (let i = 0; i < 40 && remaining.length; i++) {
      await delay(25);
      remaining = remaining.filter(live);
    }
    for (const t of timers) {
      clearTimeout(t);
    }
    for (const ws of server.clients) {
      ws.terminate();
    }
    await new Promise((resolve) => {
      server.close(resolve);
    });
    if (httpServer) {
      await new Promise((resolve) => {
        httpServer.close(resolve);
      });
    }
    if (remaining.length && !cleanupError) {
      cleanupError = new Error(
        "owned processes did not exit cleanly: " +
          JSON.stringify({
            observedPIDs: [...owned],
            forcedPIDs: forced,
            remainingPIDs: remaining,
          }),
      );
    }
    if (forced.length && !cleanupError) {
      cleanupError = new Error(
        "owned processes did not exit cleanly: " +
          JSON.stringify({
            observedPIDs: [...owned],
            forcedPIDs: forced,
            remainingPIDs: remaining,
          }),
      );
    }
    result = {
      ...result,
      pinMode,
      upgradeCount,
      connectCount,
      floodEventsQueued,
      admittedNeverRequestsByBatch: Object.fromEntries(batchCounts),
      echoedBatches,
      nativeCapacity,
      ...(kind === "framing" || kind === "startup" || kind === "writer-overflow"
        ? { framingBytes }
        : {}),
      ...(kind === "startup" || kind === "writer-overflow"
        ? { startupChildPIDs, connectionsBeforeActivation }
        : {}),
      cleanup: { observedPIDs: [...owned], forcedPIDs: forced, remainingPIDs: remaining },
      stderr,
    };
    fs.writeFileSync(root + "/" + label + "-" + pinMode + ".json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
  if (cleanupError) {
    throw cleanupError;
  }
}
(async () => {
  const scenarios =
    kind === "tls"
      ? ["match", "mismatch"]
      : kind === "startup"
        ? [
            "startup-delayed",
            "startup-claimed",
            "startup-cancelled",
            "startup-exit",
            "startup-stalled",
            "startup-discarded",
            "startup-reconnect",
          ]
        : kind === "framing"
          ? ["idle-after-control", "within-budget", "partial-prefix", "combined-budget"]
          : [kind];
  for (const scenario of scenarios) {
    await run(scenario);
  }
})().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exitCode = 1;
});
