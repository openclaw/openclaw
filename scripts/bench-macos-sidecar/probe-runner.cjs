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
  const batchCounts = new Map();
  const echoedBatches = [];
  const timers = [];
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
        ws.send(
          JSON.stringify({
            type: "event",
            event: "benchmark.post-hello",
            payload: { immediate: true },
          }),
        );
      } else if (f.method === "benchmark.delay") {
        timers.push(setTimeout(() => reply({ delayed: true }), f.params.delayMs));
      } else if (f.method === "benchmark.never") {
        if (f.params?.batch !== undefined) {
          const batch = f.params.batch;
          const count = (batchCounts.get(batch) || 0) + 1;
          batchCounts.set(batch, count);
          if (count === 64) {
            ws.send(
              JSON.stringify({ type: "event", event: "benchmark.batch-ready", payload: { batch } }),
            );
          }
        }
      } else {
        if (f.method === "benchmark.echo") {
          echoedBatches.push(f.params?.batch);
        }
        reply(f.params || {});
      }
    });
  });
  const name =
    kind === "tls" ? "tls-probe" : mode === "baseline" ? "auxiliary-baseline" : "auxiliary-probe";
  const url = `${kind === "tls" ? "wss" : "ws"}://127.0.0.1:${port}`;
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
      mode,
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
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const monitor = setInterval(() => {
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
      delay(kind === "tls" ? 15000 : 75000).then(() => null),
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
      admittedNeverRequestsByBatch: Object.fromEntries(batchCounts),
      echoedBatches,
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
  for (const scenario of kind === "tls" ? ["match", "mismatch"] : ["aux"]) {
    await run(scenario);
  }
})().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exitCode = 1;
});
