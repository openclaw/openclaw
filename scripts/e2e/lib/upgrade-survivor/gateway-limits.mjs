// Installed-package proof with synthetic model traffic; no native service manager.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runCancelableCommand } from "../../../lib/cancelable-command.mts";
import { toErrorObject } from "../../../lib/error-format.mts";
import { hasUnjoinedWork, runManagedCommand } from "../../../lib/managed-child-process.mts";
import { applyMockOpenAiModelConfig } from "../fixtures/mock-openai-config.mjs";

const [entry, home, artifacts, mode, existingConfig] = process.argv.slice(2);
assert(entry && home && artifacts && ["default", "configured"].includes(mode));
assert(!fs.existsSync(home), "Proof requires a fresh, owned home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });
const capacity = mode === "configured" ? 12 : 8;
const configPath = existingConfig ?? path.join(home, "openclaw.json");
const control = path.join(home, "response-control.json");
const events = new EventEmitter();
const children = [];
const env = {
  // Do not inherit the managed-update fixture's systemctl shim.
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  TMPDIR: home,
  OPENCLAW_STATE_DIR: existingConfig ? path.dirname(existingConfig) : path.join(home, "state"),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_NO_PROMPT: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENAI_API_KEY: "gateway-limits-synthetic-key",
};
const token = "gateway-limits-synthetic-token";
let requests = 0;
let commandNumber = 0;
let scenarioSignal;
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const hold = (held) => writeJson(control, { hold: held, text: "GATEWAY_LIMITS_OK" });

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(toErrorObject(error, "Port close failed"));
      } else {
        resolve();
      }
    });
  });
  return port;
}

function start(name, args, childEnv = env, ipc = false) {
  const abort = new AbortController();
  const state = { output: "", child: undefined, abort, settled: false };
  const fd = fs.openSync(path.join(artifacts, `${name}.log`), "w");
  state.done = runManagedCommand({
    bin: process.execPath,
    args,
    env: childEnv,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    signal: AbortSignal.any([scenarioSignal, abort.signal]),
    timeoutMs: 240_000,
    requireProcessTreeExit: true,
    onReady(child) {
      state.child = child;
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          fs.writeSync(fd, chunk);
          state.output = `${state.output}${chunk}`.slice(-1_000_000);
          events.emit("change");
        });
      }
      child.on("message", (message) => {
        if (message.type === "mock-openai:request-logged") {
          requests += 1;
          events.emit("change");
        }
      });
    },
  })
    .then(
      (code) => {
        state.code = code;
      },
      /** @param {unknown} error */
      (error) => {
        state.error = error;
      },
    )
    .finally(() => {
      state.settled = true;
      fs.closeSync(fd);
      events.emit("change");
    });
  children.push(state);
  return state;
}

async function observe(predicate, label, timeoutMs = 45_000) {
  const signal = AbortSignal.any([scenarioSignal, AbortSignal.timeout(timeoutMs)]);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      events.off("change", check);
      signal.removeEventListener("abort", fail);
    };
    const fail = () => {
      cleanup();
      reject(new Error(`Timed out or cancelled: ${label}`, { cause: signal.reason }));
    };
    const check = () => {
      if (predicate()) {
        cleanup();
        resolve();
      }
    };
    events.on("change", check);
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) {
      fail();
    } else {
      check();
    }
  });
}

async function cli(...args) {
  const command = start(`cli-${commandNumber++}`, [entry, ...args]);
  await command.done;
  if (command.error) {
    throw command.error;
  }
  assert.equal(command.code, 0, command.output);
  return command.output;
}

function parseJson(output) {
  return JSON.parse(output.slice(output.indexOf("{")));
}

async function cleanupChildren() {
  hold(false);
  for (const child of children) {
    if (!child.settled) {
      child.abort.abort();
    }
  }
  await Promise.all(children.map((child) => child.done));
  const unjoined = children.find((child) => hasUnjoinedWork(child.error));
  if (unjoined) {
    throw unjoined.error;
  }
}

process.exitCode = await runCancelableCommand(async (signal) => {
  scenarioSignal = signal;
  const started = performance.now();
  const trace = { mode, capacity, supervisor: "foreground; no systemd/launchd proof" };
  try {
    hold(true);
    const mock = start(
      "mock",
      ["scripts/e2e/mock-openai-server.mjs"],
      {
        ...env,
        MOCK_PORT: "0",
        MOCK_RESPONSE_CONTROL: control,
        MOCK_REQUEST_LOG: path.join(artifacts, "model-requests.jsonl"),
      },
      true,
    );
    await observe(() => /mock-openai listening on (\d+)/u.test(mock.output), "mock listener");
    const mockPort = Number(mock.output.match(/mock-openai listening on (\d+)/u)[1]);
    const port = await freePort();
    const retained = existingConfig ? JSON.parse(fs.readFileSync(existingConfig, "utf8")) : {};
    if (existingConfig) {
      assert.equal(retained.cron?.maxConcurrentRuns, capacity);
    }
    const config = {
      ...retained,
      gateway: {
        ...retained.gateway,
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token },
        reload: { mode: "off" },
        controlUi: { enabled: false },
        ...(mode === "configured" ? { stopTimeoutMs: 15_000 } : {}),
      },
      hooks: {
        enabled: true,
        token: "gateway-limits-synthetic-hook",
        allowRequestSessionKey: true,
        allowedSessionKeyPrefixes: ["hook:"],
      },
      cron: {
        ...retained.cron,
        enabled: true,
        ...(mode === "configured" ? { maxConcurrentRuns: capacity } : {}),
      },
      agents: {
        ...retained.agents,
        defaults: {
          ...retained.agents?.defaults,
          workspace: path.join(home, "workspace"),
          heartbeat: { every: "0m" },
        },
      },
    };
    applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gateway-limits-fixture" });
    config.plugins.allow = ["openai"];
    writeJson(configPath, config);
    await cli("doctor", "--fix", "--non-interactive");
    if (mode === "configured") {
      const afterDoctor = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.equal(afterDoctor.cron.maxConcurrentRuns, capacity);
      assert.equal(afterDoctor.gateway.stopTimeoutMs, 15_000);
    }
    // The canonical readiness probe owns startup retries and its deadline.
    const ready = async () => {
      const probe = start(`ready-${commandNumber++}`, [
        "scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs",
        "--base-url",
        `http://127.0.0.1:${port}`,
        "--path",
        "/readyz",
        "--expect",
        "ready",
        "--timeout-ms",
        "60000",
        "--out",
        path.join(artifacts, "ready.json"),
      ]);
      await probe.done;
      if (probe.error) {
        throw probe.error;
      }
      assert.equal(probe.code, 0, probe.output);
    };
    const gateway = start("gateway", [entry, "gateway", "run"]);
    await ready();
    const rpc = async (method, params) =>
      parseJson(
        await cli(
          "gateway",
          "call",
          method,
          "--params",
          JSON.stringify(params),
          "--url",
          `ws://127.0.0.1:${port}`,
          "--token",
          token,
          "--json",
        ),
      );
    let hookNumber = 0;
    const hook = async (waitForCompletion = false) => {
      const response = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-limits-synthetic-hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: "Reply GATEWAY_LIMITS_OK",
          sessionKey: `hook:limits-${hookNumber++}`,
          deliver: false,
          waitForCompletion,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      return { status: response.status, body: await response.json() };
    };
    // Hooks occupy C-1 slots; the cron job must enter the same shared budget.
    for (let index = 0; index < capacity - 1; index += 1) {
      const result = await hook();
      assert.equal(result.status, 200, JSON.stringify(result));
    }
    const job = await rpc("cron.add", {
      name: "gateway-limits",
      enabled: false,
      schedule: { kind: "every", everyMs: 86_400_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Reply GATEWAY_LIMITS_OK" },
      delivery: { mode: "none" },
    });
    await rpc("cron.run", { id: job.id, mode: "force", waitTimeoutMs: 0 });
    await observe(() => requests === capacity, "mixed shared capacity");
    const overflow = await hook();
    assert.equal(overflow.status, 503, JSON.stringify(overflow));
    assert.match(overflow.body.error, /admission timeout/u);
    assert.equal(requests, capacity, "Overflow must not reach the model");
    trace.observedConcurrentRequests = requests;
    hold(false);
    const afterRelease = await hook(true);
    assert.equal(afterRelease.status, 200, JSON.stringify(afterRelease));
    assert.equal(afterRelease.body.completion?.status, "ok", JSON.stringify(afterRelease));
    await observe(() => requests > capacity, "released slot admits work");
    if (mode === "configured") {
      hold(true);
      const beforeBusy = requests;
      assert.equal((await hook()).status, 200);
      await observe(() => requests > beforeBusy, "busy work reached model");
    }
    const stopAt = performance.now();
    assert(gateway.child.kill("SIGTERM"));
    if (mode === "configured") {
      await observe(
        () => gateway.output.includes("draining active work before stop"),
        "native busy drain",
      );
      trace.repeatedSignalMs = performance.now() - stopAt;
      assert(gateway.child.kill("SIGTERM"));
    }
    await observe(() => gateway.settled, "native stop exit", 20_000);
    if (gateway.error) {
      throw gateway.error;
    }
    assert.equal(gateway.code, 0, gateway.output);
    trace.stopMs = performance.now() - stopAt;
    if (mode === "configured") {
      assert(trace.stopMs < 18_000, "Stop exceeded configured budget plus scheduling tolerance");
      assert.match(gateway.output, /active-work drain timeout reached/u);
      assert.match(gateway.output, /active-work drain settled; beginning server close/u);
      hold(false);
    }
    const successor = start("successor", [entry, "gateway", "run"]);
    await ready();
    assert(successor.child.kill("SIGTERM"));
    await observe(() => successor.settled, "idle successor stop", 20_000);
    if (successor.error) {
      throw successor.error;
    }
    assert.equal(successor.code, 0, successor.output);
    trace.successorReady = true;
    trace.wallMs = performance.now() - started;
    writeJson(path.join(artifacts, "summary.json"), trace);
    console.log(JSON.stringify(trace));
    return 0;
  } finally {
    await cleanupChildren();
    // The caller owns home cleanup; retain it with diagnostics if anything fails.
  }
});
