const { WebSocketServer } = require(
  require.resolve("ws", { paths: [process.env.OPENCLAW_BENCH_REPO || process.cwd()] }),
);
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const root = process.env.RFC54_BENCH_ROOT || __dirname;
const mode = process.argv[2] || root + "/bin/openclaw-mac-node-sidecar";
const label = process.argv[3] || "candidate-functional";
const functionalProbe = process.env.RFC54_FUNCTIONAL_PROBE || root + "/bin/functional-probe";
const gatewayPayloadLimit = 25 * 1024 * 1024;
const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
function descendants(pid) {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((x) => x.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]);
  for (let i = 0; i < 4; i++) {
    for (const [id, parent] of rows) {
      if (ids.has(parent)) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}
function deadline(p, deadlineLabel, milliseconds = 5000) {
  return Promise.race([
    p,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(deadlineLabel + " timed out")), milliseconds);
      timer.unref();
    }),
  ]);
}
(async () => {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: false,
    autoPong: false,
    maxPayload: gatewayPayloadLimit,
  });
  await once(server, "listening");
  let ws;
  let child;
  let stderr = "";
  let stdout = "";
  const results = new Map(),
    progress = new Map(),
    cancelled = new Set(),
    cancelEvents = new Map(),
    nativeEntered = new Set(),
    nativeEffects = new Set(),
    nativeRejectedBeforeEffect = new Set();
  let startupFailure;
  const startup = { beganAt: Date.now() };
  let nextPing;
  let nativeRouteRetired = false;
  const observed = new Set();
  let finished = false;
  const mediaResultsReceived = new Set();
  const mediaResultsValidated = new Set();
  const record = { mode, checks: [] };
  server.on("connection", (socket) => {
    ws = socket;
    startup.gatewayConnectedAfterMs = Date.now() - startup.beganAt;
    socket.on("ping", (data) => {
      if (nextPing) {
        const pending = nextPing;
        nextPing = undefined;
        socket.send(JSON.stringify({ type: "event", event: "tick", payload: { ts: Date.now() } }));
        if (pending.reply) {
          setTimeout(() => socket.pong(data), 50);
        }
        pending.resolve(socket);
      } else {
        socket.pong(data);
      }
    });
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "functional-nonce", ts: Date.now() },
      }),
    );
    socket.on("message", (raw) => {
      const f = JSON.parse(raw);
      if (f.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: f.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: f.params.maxProtocol,
              server: { version: "fixture", connId: "functional" },
              features: {
                methods: ["node.invoke.result", "node.invoke.progress"],
                events: [],
                capabilities: [],
              },
              snapshot: {
                presence: [{ ts: 1 }],
                health: {},
                stateVersion: { presence: 0, health: 0 },
                uptimeMs: 0,
              },
              policy: {
                maxPayload: gatewayPayloadLimit,
                maxBufferedBytes: 2 * gatewayPayloadLimit,
                tickIntervalMs: 30000,
              },
              auth: { role: "node", scopes: [] },
            },
          }),
        );
      } else {
        socket.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload: {} }));
        if (f.method === "node.invoke.result") {
          results.set(f.params.id, f.params);
          if (f.params.id.startsWith("parallel-media-")) {
            mediaResultsReceived.add(f.params.id);
          }
        }
        if (f.method === "node.invoke.progress") {
          progress.set(f.params.invokeId, f.params);
        }
      }
    });
  });
  const ready = new Promise((resolve, reject) => {
    child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-D",
        `BENCH_ROOT=${fs.realpathSync(root)}`,
        "-D",
        `BENCH_ENDPOINT=localhost:${server.address().port}`,
        "-f",
        root + "/sandbox.sb",
        functionalProbe,
        `ws://127.0.0.1:${server.address().port}`,
        mode,
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
    observed.add(child.pid);
    child.stdout.on("data", (data) => {
      stdout += data;
      while (stdout.includes("\n")) {
        const index = stdout.indexOf("\n");
        const line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        if (!line) {
          continue;
        }
        const row = JSON.parse(line);
        if (row.ready) {
          startup.readyAfterMs = Date.now() - startup.beganAt;
          resolve();
        }
        if (row.nativeCancelled) {
          cancelled.add(row.nativeCancelled);
        }
        if (row.nativeCancelEvent) {
          cancelEvents.set(
            row.nativeCancelEvent,
            (cancelEvents.get(row.nativeCancelEvent) || 0) + 1,
          );
        }
        if (row.nativeEntered) {
          nativeEntered.add(row.nativeEntered);
        }
        if (row.nativeEffect) {
          nativeEffects.add(row.nativeEffect);
        }
        if (row.nativeRejectedBeforeEffect) {
          nativeRejectedBeforeEffect.add(row.nativeRejectedBeforeEffect);
        }
        if (row.nativeRouteRetired) {
          nativeRouteRetired = true;
        }
        if (row.startupFailure) {
          startupFailure = row.startupFailure;
          startup.failure = row.startupFailure;
          startup.failedAfterMs = Date.now() - startup.beganAt;
        }
      }
    });
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code, signal) => reject(new Error(`exit ${code}/${signal} ${stderr}`)));
  });
  async function until(predicate, waitLabel) {
    return deadline(
      (async () => {
        while (!predicate()) {
          if (finished) {
            throw new Error("fixture finished");
          }
          await delay(5);
        }
        return predicate();
      })(),
      waitLabel,
    );
  }
  // Keep the production 15-second keepalive; application deadlines remain five seconds.
  const orderedKeepalive = (reply) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("15-second keepalive missing")), 20000);
      timer.unref();
      nextPing = {
        reply,
        resolve: (socket) => {
          clearTimeout(timer);
          resolve(socket);
        },
      };
    });
  const invoke = (id, command, params = { data: "native" }, timeoutMs = 30000) =>
    ws.send(
      JSON.stringify({
        type: "event",
        event: "node.invoke.request",
        payload: {
          id,
          nodeId: "functional-node",
          command,
          paramsJSON: JSON.stringify(params),
          timeoutMs,
          idempotencyKey: id,
        },
      }),
    );
  const payload = (result) =>
    result.payloadJSON === undefined ? result.payload : JSON.parse(result.payloadJSON);
  /** @type {Error | undefined} */
  let cleanupError;
  try {
    // GatewayChannel owns a 30-second connect budget, including bundled verification.
    // Allow that result to settle before the fixture expires; application checks stay at five seconds.
    await deadline(ready, "startup", 35000);
    if (process.env.RFC54_EXPECT_STARTUP_REJECTION) {
      throw new Error("expected helper rejection before Gateway connection");
    }
    for (const pid of descendants(child.pid)) {
      observed.add(pid);
    }
    for (const [id, raw] of [
      ["raw-missing", undefined],
      ["raw-null", "null"],
      ["raw-order", '{ "b":2, "a":1 }'],
    ]) {
      const item = {
        id,
        nodeId: "functional-node",
        command: "benchmark.raw",
        timeoutMs: 30000,
        idempotencyKey: id,
      };
      if (raw !== undefined) {
        item.paramsJSON = raw;
      }
      ws.send(JSON.stringify({ type: "event", event: "node.invoke.request", payload: item }));
      const res = await until(() => results.get(id), "original paramsJSON");
      const body = payload(res);
      if (
        !res.ok ||
        body.present !== (raw !== undefined) ||
        body.raw !== (raw === undefined ? "missing" : raw)
      ) {
        throw new Error("original paramsJSON changed: " + JSON.stringify({ id, res }));
      }
    }
    record.checks.push({
      scenario: "missing, literal null, original whitespace/key-order paramsJSON preserved",
      passed: true,
    });
    // Observe the actual node.invoke.result frame: a parsed null cannot prove absence.
    const resultCases = [
      { name: "absent", command: "benchmark.echo", expected: { ok: true } },
      {
        name: "null",
        command: "benchmark.echo",
        paramsJSON: "null",
        expected: { ok: true, payloadJSON: "null" },
      },
      {
        name: "object",
        command: "benchmark.echo",
        paramsJSON: '{"value":"present"}',
        expected: { ok: true, payloadJSON: '{"value":"present"}' },
      },
      {
        name: "error",
        command: "benchmark.large",
        paramsJSON: '{"bytes":-1}',
        expected: { ok: false, error: { code: "INVALID_REQUEST", message: "invalid probe size" } },
      },
    ];
    const resultFailures = [];
    for (const item of resultCases) {
      const id = `result-contract-${item.name}`;
      const request = {
        id,
        nodeId: "functional-node",
        command: item.command,
        timeoutMs: 30000,
        idempotencyKey: id,
        ...(item.paramsJSON === undefined ? {} : { paramsJSON: item.paramsJSON }),
      };
      ws.send(JSON.stringify({ type: "event", event: "node.invoke.request", payload: request }));
      const result = await until(() => results.get(id), `native ${item.name} result contract`);
      const expected = { id, nodeId: "functional-node", ...item.expected };
      let passed = true;
      try {
        assert.deepStrictEqual(result, expected);
      } catch {
        passed = false;
        resultFailures.push(item.name);
      }
      record.checks.push({
        scenario: `native ${item.name} result preserves wire payload presence`,
        passed,
        expected,
        result,
      });
      results.delete(id);
    }
    if (resultFailures.length) {
      throw new Error("native result presence mismatch: " + resultFailures.join(", "));
    }
    invoke("system-one", "system.echo", { source: "Swift native handler" });
    const system = await until(() => results.get("system-one"), "system admission");
    if (!system.ok || payload(system).source !== "Swift native handler") {
      throw new Error("system echo mismatch");
    }
    record.checks.push({ scenario: "system command admission and native result", passed: true });
    for (const bytes of [17 * 1024 * 1024, gatewayPayloadLimit - 4096]) {
      const id = "large-" + bytes;
      invoke(id, "benchmark.large", { bytes });
      const result = await until(() => results.get(id), "large native result");
      const body = payload(result);
      if (!result.ok || typeof body !== "string" || body.length !== bytes || !/^x+$/u.test(body)) {
        throw new Error("large native result failed integrity: " + bytes);
      }
      results.delete(id);
      record.checks.push({
        scenario: "native media-sized result crosses IPC and Gateway",
        bytes,
        passed: true,
      });
    }
    // Quotes, backslashes, and newlines expand twice across the serialized result
    // envelope. Keep the wire below 25 MiB while checking the private worker contract.
    const escapedText = String.fromCharCode(34, 92, 10).repeat(1024 * 1024);
    invoke("escaped-result", "benchmark.echo", { text: escapedText });
    const escapedResult = await until(() => results.get("escaped-result"), "escaped native result");
    if (
      !escapedResult.ok ||
      typeof escapedResult.payloadJSON !== "string" ||
      payload(escapedResult).text !== escapedText
    ) {
      throw new Error("native serialized result changed escaped JSON content");
    }
    results.delete("escaped-result");
    record.checks.push({
      scenario: "serialized native result preserves quotes, backslashes, and newlines",
      passed: true,
    });
    // Concurrent native completions must wait for the bounded IPC writer without
    // replacing a healthy connection. Pause reads to make byte pressure reproducible.
    const mediaSocket = ws;
    const bytes = gatewayPayloadLimit - 4096;
    mediaSocket.pause();
    const resumeMedia = setTimeout(() => mediaSocket.resume(), 1500);
    try {
      for (let i = 0; i < 4; i++) {
        invoke(`parallel-media-${i}`, "benchmark.large", { bytes });
      }
      await until(() => mediaResultsReceived.size === 4, "concurrent native media");
      for (let i = 0; i < 4; i++) {
        const id = `parallel-media-${i}`;
        const result = results.get(id);
        const body = payload(result);
        if (
          !result.ok ||
          typeof body !== "string" ||
          body.length !== bytes ||
          !/^x+$/u.test(body)
        ) {
          throw new Error("concurrent native media failed integrity: " + id);
        }
        mediaResultsValidated.add(id);
        results.delete(id);
      }
      if (ws !== mediaSocket || nativeRouteRetired) {
        throw new Error("concurrent media replaced the native route");
      }
      record.checks.push({
        scenario: "four concurrent near-limit native results survive paused Gateway reads",
        bytes,
        passed: true,
      });
    } finally {
      clearTimeout(resumeMedia);
      mediaSocket.resume();
    }
    if (mode !== "baseline") {
      invoke("large-rejected", "benchmark.large", { bytes: gatewayPayloadLimit + 1 });
      const rejected = await until(() => results.get("large-rejected"), "oversized native result");
      if (rejected.ok || rejected.error?.code !== "OUTPUT_TOO_LARGE") {
        throw new Error("oversized native result did not yield bounded rejection");
      }
      record.checks.push({
        scenario: "oversized native result is rejected without retiring IPC",
        passed: true,
      });
    }
    invoke("after-large", "benchmark.echo", { alive: true });
    const afterLarge = await until(
      () => results.get("after-large"),
      "session reuse after large native output",
    );
    if (!afterLarge.ok || payload(afterLarge).alive !== true) {
      throw new Error("native output limits retired the node session");
    }
    invoke("duplex-one", "benchmark.duplex");
    const initial = await until(() => progress.get("duplex-one"), "duplex progress");
    if (initial.seq !== 0 || initial.chunk !== "native-start") {
      throw new Error("progress integrity");
    }
    const input = { source: "Gateway input", unicode: "☃" };
    ws.send(
      JSON.stringify({
        type: "event",
        event: "node.invoke.input",
        payload: {
          id: "duplex-one",
          nodeId: "functional-node",
          seq: 0,
          payloadJSON: JSON.stringify(input),
        },
      }),
    );
    const duplex = await until(() => results.get("duplex-one"), "duplex result");
    if (!duplex.ok || JSON.stringify(payload(duplex)) !== JSON.stringify(input)) {
      throw new Error("duplex payload mismatch");
    }
    record.checks.push({
      scenario: "native progress and Gateway input reach Swift; result integrity",
      passed: true,
    });
    invoke("cancel-one", "system.notify");
    await until(() => progress.get("cancel-one"), "cancel handler startup");
    ws.send(
      JSON.stringify({
        type: "event",
        event: "node.invoke.cancel",
        payload: { invokeId: "cancel-one", nodeId: "functional-node" },
      }),
    );
    const cancelledResult = await until(() => results.get("cancel-one"), "cancel result");
    if (cancelledResult.ok) {
      throw new Error("cancel succeeded unexpectedly");
    }
    await until(() => cancelled.has("cancel-one"), "native Swift task cancellation");
    record.checks.push({
      scenario: "Gateway cancellation reaches native Swift task and yields failed result",
      passed: true,
      error: cancelledResult.error,
    });
    await delay(50);
    if (cancelEvents.get("cancel-one") !== 1) {
      throw new Error("expected exactly one native cancellation event");
    }
    if (cancelEvents.has("system-one") || cancelEvents.has("duplex-one")) {
      throw new Error("spurious cancellation after native completion");
    }
    invoke("timeout-one", "system.notify", {}, 200);
    await until(() => progress.get("timeout-one"), "timeout handler startup");
    const timed = await until(() => results.get("timeout-one"), "timeout result");
    if (timed.ok) {
      throw new Error("timeout succeeded unexpectedly");
    }
    await until(() => cancelled.has("timeout-one"), "native Swift task timeout cleanup");
    record.checks.push({
      scenario: "deadline stops native Swift task and yields failed result",
      passed: true,
      error: timed.error,
    });
    const retirementMode = process.env.RFC54_CHECK_RETIREMENT;
    if (mode !== "baseline" && retirementMode) {
      const id = "retire-during-delivery";
      invoke(id, "system.notify");
      await until(() => nativeEntered.has(id), "native retirement handoff");
      let retiredBoundary;
      if (retirementMode === "1" || retirementMode === "helper") {
        const helperPath = fs.realpathSync(mode);
        const helperPID = await until(() => {
          for (const pid of descendants(child.pid)) {
            if (pid === child.pid) {
              continue;
            }
            try {
              const executable = execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], {
                encoding: "utf8",
              }).trim();
              if (fs.realpathSync(executable) === helperPath) {
                return pid;
              }
            } catch {}
          }
          return undefined;
        }, "Rust helper process");
        process.kill(helperPID, "SIGTERM");
        retiredBoundary = "helper process";
      } else if (retirementMode === "gateway") {
        ws.terminate();
        retiredBoundary = "Gateway WebSocket session";
      } else {
        throw new Error(`unknown RFC54_CHECK_RETIREMENT mode: ${retirementMode}`);
      }
      await until(() => nativeRouteRetired, "native route retirement");
      fs.writeFileSync(root + "/retirement-release-" + id, "release\n");
      await until(
        () => nativeRejectedBeforeEffect.has(id),
        "native retirement before final effect",
      );
      await delay(100);
      if (nativeEffects.has(id)) {
        throw new Error("retired session reached the native effect");
      }
      record.checks.push({
        scenario: `${retiredBoundary} retirement during native delivery prevents the final effect`,
        passed: true,
        retirementBoundary: retiredBoundary,
      });
    }
    if (!retirementMode) {
      const keepaliveSocket = await orderedKeepalive(true);
      invoke("after-ordered-pong", "benchmark.echo", { alive: true });
      const echoed = await until(
        () => results.get("after-ordered-pong"),
        "echo with tick preceding Pong",
      );
      if (!echoed.ok || payload(echoed).alive !== true) {
        throw new Error("ordered Pong blocked native result");
      }
      // A fabricated successful Pong could pass the echo but later retire on the real ten-second timeout.
      await delay(11000);
      if (ws !== keepaliveSocket || nativeRouteRetired || keepaliveSocket.readyState !== 1) {
        throw new Error("real Pong did not preserve the original native route");
      }
      record.checks.push({
        scenario: "tick before delayed Pong preserves receive progress and native keepalive",
        passed: true,
      });
      if (mode !== "baseline") {
        const missingPongSocket = await orderedKeepalive(false);
        const retired = Promise.race([
          once(missingPongSocket, "close"),
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("missing Pong did not retire transport")),
              12000,
            );
            timer.unref();
          }),
        ]);
        invoke("before-missing-pong-timeout", "benchmark.echo", { alive: true });
        const beforeTimeout = await until(
          () => results.get("before-missing-pong-timeout"),
          "receive while real Pong is absent",
        );
        if (!beforeTimeout.ok) {
          throw new Error("pending Pong blocked application delivery");
        }
        await retired;
        await until(() => nativeRouteRetired, "native route retirement after missing Pong");
        record.checks.push({
          scenario: "missing real Pong times out and retires the native route",
          passed: true,
        });
      }
    }
  } catch (error) {
    const expectedStartupRejection = process.env.RFC54_EXPECT_STARTUP_REJECTION;
    const startupExit = /^exit ([^/]+)\//u.exec(error.message);
    const expectedStartup = {
      missing: { domain: "OpenClawRustSidecarStartup", code: 3 },
      incompatible: { domain: "OpenClawRustSidecarStartup", code: 4 },
      signature: { domain: "OpenClawRustSidecar", code: 2 },
    }[expectedStartupRejection];
    if (
      expectedStartup &&
      !ws &&
      nativeEntered.size === 0 &&
      nativeEffects.size === 0 &&
      startupExit &&
      startupExit[1] !== "0" &&
      startupFailure?.domain === expectedStartup.domain &&
      startupFailure.code === expectedStartup.code
    ) {
      record.checks.push({
        scenario: `${expectedStartupRejection} helper rejected before Gateway connection or native effect`,
        passed: true,
        failurePhase: "typed transport startup rejection before Gateway connection",
        startupFailure,
      });
    } else {
      record.failure = error.message;
      throw error;
    }
  } finally {
    finished = true;
    for (const pid of descendants(child.pid)) {
      observed.add(pid);
    }
    child.stdin.end();
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) {
      await delay(20);
    }
    const forced = [];
    const live = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let remaining = [...observed].filter(live);
    for (let i = 0; i < 50 && remaining.length; i++) {
      await delay(20);
      remaining = remaining.filter(live);
    }
    for (const pid of remaining) {
      forced.push(pid);
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    for (let i = 0; i < 50 && remaining.length; i++) {
      await delay(20);
      remaining = remaining.filter(live);
    }
    record.startup = startup;
    record.mediaResultsReceived = [...mediaResultsReceived];
    record.mediaResultsValidated = [...mediaResultsValidated];
    record.nativeCancelEvents = Object.fromEntries(cancelEvents);
    record.cleanup = { observedPIDs: [...observed], forcedPIDs: forced, remainingPIDs: remaining };
    record.stderr = stderr;
    fs.rmSync(root + "/retirement-release-retire-during-delivery", { force: true });
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise((resolve) => {
      server.close(resolve);
    });
    fs.writeFileSync(root + "/" + label + ".json", JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record));
    if (forced.length || remaining.length) {
      cleanupError = new Error("unclean process shutdown");
    }
  }
  if (cleanupError) {
    throw cleanupError;
  }
})().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exitCode = 1;
});
