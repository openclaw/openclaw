// Native Windows Gateway proof: real RPC history reads and junction notification bursts.
// Run with Node 26.12.1+: --root <new-output> --base <package> --head <package>
// --base-sha <commit> --head-sha <commit> [--diagnostic] [--samples 5] [--pairs 200].
// Use --warm-reads 100 for warm-tail investigations; raw per-read times are recorded.
// Smaller sample counts are setup/diagnostic smoke runs, not performance campaigns.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    base: { type: "string" },
    head: { type: "string" },
    samples: { type: "string", default: "5" },
    pairs: { type: "string", default: "200" },
    "warm-reads": { type: "string", default: "10" },
    diagnostic: { type: "boolean", default: false },
    "base-sha": { type: "string" },
    "head-sha": { type: "string" },
    replacement: { type: "string" },
    "replacement-marker": { type: "string" },
    "replacement-session-id": { type: "string" },
  },
});
assert.equal(process.platform, "win32");
for (const key of ["root", "base", "head", "base-sha", "head-sha"]) {
  assert(values[key], `Missing --${key}`);
}
for (const key of ["samples", "pairs", "warm-reads"]) {
  assert(Number.isSafeInteger(Number(values[key])) && Number(values[key]) > 0, `Invalid --${key}`);
}
const root = path.resolve(values.root);
fs.mkdirSync(root);
const results = [];
const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const write = (name, value) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const stats = (samples) => {
  const s = samples.toSorted((a, b) => a - b);
  return {
    count: s.length,
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    p95: s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)],
    max: s.at(-1),
  };
};
const freePort = async () => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((r) => {
    server.close(r);
  });
  return port;
};
async function stopGateway(child) {
  if (child.exitCode !== null) {
    return;
  }
  execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "pipe" });
  if (child.exitCode === null) {
    await once(child, "exit", { signal: AbortSignal.timeout(10000) });
  }
}
async function run(kind, index) {
  const installed = path.resolve(values[kind]);
  const build = JSON.parse(
    fs.readFileSync(path.join(installed, "dist", "build-info.json"), "utf8"),
  );
  const fixture = path.join(root, `${kind}-${index}`);
  fs.mkdirSync(fixture);
  const state = path.join(fixture, "state"),
    aliases = path.join(fixture, "aliases"),
    physical = path.join(fixture, "physical");
  for (const p of [state, aliases, physical, path.join(fixture, "workspace")]) {
    fs.mkdirSync(p, { recursive: true });
  }
  const alias = path.join(aliases, "main"),
    moved = path.join(aliases, "moved");
  fs.symlinkSync(physical, alias, "junction");
  const port = await freePort(),
    token = randomUUID();
  const config = {
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: path.join(fixture, "workspace") } },
    },
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
      tailscale: { mode: "off" },
    },
    plugins: { enabled: false },
    session: { store: path.join(aliases, "{agentId}", "history.json") },
  };
  const configPath = path.join(state, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const log = fs.openSync(path.join(fixture, "gateway.log"), "w");
  const args = [
    "--import",
    new URL("./lib/session-source-observer-preload.mjs", import.meta.url).href,
    path.join(installed, "openclaw.mjs"),
    "gateway",
    "run",
    "--port",
    String(port),
    "--bind",
    "loopback",
    "--allow-unconfigured",
  ];
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    HOME: fixture,
    USERPROFILE: fixture,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    SOURCE_PROOF_ROOT: fixture,
    SOURCE_PROOF_DIAGNOSTIC: values.diagnostic ? "1" : "0",
  };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, args, {
    cwd: fixture,
    env,
    stdio: ["ignore", log, log, "ipc"],
    windowsHide: true,
  });
  const boot = performance.now();
  let ws;
  const diagnostic = new Map();
  child.on("message", (m) => {
    if (m?.channel === "source-proof" && diagnostic.has(m.id)) {
      const p = diagnostic.get(m.id);
      diagnostic.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) {
        p.reject(new Error(m.error));
      } else {
        p.resolve(m.result);
      }
    }
  });
  const control = (action) =>
    new Promise((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(() => {
          diagnostic.delete(id);
          reject(new Error(`diagnostic ${action} timeout`));
        }, 15000);
      diagnostic.set(id, { resolve, reject, timer });
      child.send({ channel: "source-proof", id, action });
    });
  const result = {
    kind,
    index,
    diagnostic: values.diagnostic,
    node: process.version,
    arch: process.arch,
    guest: {
      release: os.release(),
      cpus: os.availableParallelism(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
    },
    build,
    phases: {},
  };
  try {
    assert.equal(result.build.commit, values[`${kind}-sha`], "Wrong installed build");
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`Gateway exited ${child.exitCode}: ${fixture}`);
      }
      if (performance.now() - boot > 180000) {
        throw new Error("Gateway readiness timeout");
      }
      if (
        await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(5000) }).then(
          (r) => r.ok,
          () => false,
        )
      ) {
        break;
      }
      await delay(200);
    }
    result.startupMs = performance.now() - boot;
    // Readiness precedes deferred startup maintenance; exclude it from warm timings.
    while (
      !/post-ready\.startup-maintenance [\d.]+ms/.test(
        fs.readFileSync(path.join(fixture, "gateway.log"), "utf8"),
      )
    ) {
      assert.equal(child.exitCode, null, "Gateway exited during warmup");
      assert(performance.now() - boot < 240000, "Startup maintenance timeout");
      await delay(200);
    }
    result.maintenanceCompletedMs = performance.now() - boot;
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const m = JSON.parse(event.data);
      if (m.type === "res" && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) {
          p.resolve(m.payload);
        } else {
          p.reject(
            Object.assign(new Error(`${p.method}: ${JSON.stringify(m.error)}`), {
              rpcError: m.error,
            }),
          );
        }
      }
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = randomUUID(),
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`RPC timeout ${method}`));
          }, 30000);
        pending.set(id, { resolve, reject, timer, method });
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });
    const hello = await rpc("connect", {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "gateway-client",
        displayName: "source-notification-proof",
        version: "1",
        platform: "win32",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [],
      auth: { token },
    });
    result.serving = hello.server;
    const session = await rpc("sessions.create", {
      agentId: "main",
      key: "agent:main:proof192941",
    });
    assert(session.ok && session.key && session.sessionId);
    assert.equal(session.runStarted, false);
    result.sessionId = session.sessionId;
    const params = { agentId: "main", sessionKey: session.key };
    const marker = `SOURCE_NOTIFICATION_PROOF_192941_${kind}_${index}`;
    assert((await rpc("chat.inject", { ...params, message: marker })).ok);
    async function history() {
      const start = performance.now();
      const h = await rpc("chat.history", { ...params, limit: 20 });
      assert.equal(h.sessionId, session.sessionId);
      assert(JSON.stringify(h.messages).includes(marker));
      return performance.now() - start;
    }
    await history();
    await history();
    await delay(500);
    if (values.diagnostic) {
      await control("profile-start");
      await control("reset");
    }
    const warmed = [];
    for (let j = 0; j < Number(values["warm-reads"]); j++) {
      warmed.push(await history());
    }
    result.warmHistory = stats(warmed);
    result.warmHistorySamples = warmed;
    if (values.diagnostic) {
      result.phases.warm = await control("snapshot");
      const profile = await control("profile-stop");
      fs.writeFileSync(path.join(fixture, "warm.cpuprofile"), JSON.stringify(profile.profile));
    }
    if (values.diagnostic) {
      await control("profile-start");
    }
    await control("reset");
    const timings = [],
      failures = [];
    const probeController = new AbortController();
    const probes = (async () => {
      while (!probeController.signal.aborted) {
        const t = performance.now();
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) {
            failures.push(response.status);
          }
          timings.push(performance.now() - t);
        } catch (e) {
          failures.push(String(e));
        }
        await delay(10);
      }
    })();
    const burstStart = performance.now();
    try {
      for (let j = 0; j < Number(values.pairs); j++) {
        fs.renameSync(alias, moved);
        fs.renameSync(moved, alias);
        await delay(10);
      }
      await delay(300);
    } finally {
      probeController.abort();
      await probes;
    }
    result.burstMs = performance.now() - burstStart;
    result.health = stats(timings);
    result.healthFailures = failures;
    assert.equal(failures.length, 0);
    result.phases.burst = await control("snapshot");
    if (values.diagnostic) {
      const profile = await control("profile-stop");
      fs.writeFileSync(path.join(fixture, "burst.cpuprofile"), JSON.stringify(profile.profile));
      await control("reset");
    }
    result.firstHistoryMs = await history();
    if (values.diagnostic) {
      result.phases.firstRead = await control("snapshot");
      await control("reset");
    }
    result.nextHistoryMs = await history();
    if (values.diagnostic) {
      result.phases.nextRead = await control("snapshot");
    }
    assert.equal(fs.realpathSync(alias), fs.realpathSync(physical));
    result.historyPreserved = true;
    if (values.replacement) {
      const replacement = path.resolve(values.replacement);
      assert(fs.statSync(replacement).isDirectory());
      assert.notEqual(fs.realpathSync(replacement), fs.realpathSync(physical));
      fs.renameSync(alias, path.join(aliases, "retired"));
      fs.symlinkSync(replacement, alias, "junction");
      await delay(300);
      const begin = performance.now();
      let changed;
      let rejected;
      try {
        changed = await rpc("chat.history", { ...params, limit: 20 });
      } catch (error) {
        rejected = error;
      }
      if (rejected) {
        result.replacement = {
          outcome: "rejected",
          error: rejected.message,
          rpcError: rejected.rpcError,
          ms: performance.now() - begin,
        };
        assert(rejected.rpcError, "Transport failure is not replacement safety proof");
        assert(
          /changed outside captured discovery custody|Session store changed|database identity|database.*replaced/i.test(
            rejected.rpcError.message,
          ),
          "Unexpected rejection is not replacement safety proof",
        );
      } else {
        assert(Array.isArray(changed.messages), "Malformed history response");
        assert(values["replacement-marker"], "Supply the expected replacement marker");
        const text = JSON.stringify(changed.messages);
        assert(!text.includes(marker), "Retargeted alias returned stale original content");
        // The resident metadata row can still select the old session ID, which
        // has no transcript in this independently seeded replacement store.
        assert(
          changed.messages.length === 0 || text.includes(values["replacement-marker"]),
          "Unexpected replacement content",
        );
        assert.equal(
          changed.sessionId,
          changed.messages.length === 0 ? session.sessionId : values["replacement-session-id"],
          "Default history selected an unexpected session ID",
        );
        assert(values["replacement-session-id"], "Supply the seeded replacement session ID");
        assert.notEqual(values["replacement-session-id"], session.sessionId);
        const alternate = await rpc("chat.history", {
          ...params,
          limit: 20,
          sessionId: values["replacement-session-id"],
        });
        assert.equal(alternate.sessionId, values["replacement-session-id"]);
        assert(Array.isArray(alternate.messages));
        const alternateText = JSON.stringify(alternate.messages);
        assert(alternateText.includes(values["replacement-marker"]), "Replacement content missing");
        assert(
          !alternateText.includes(marker),
          "Explicit replacement read returned original content",
        );
        result.replacement = {
          outcome: "replacement-content",
          defaultMessageCount: changed.messages.length,
          sessionId: alternate.sessionId,
          oldMarkerReturned: false,
          ms: performance.now() - begin,
        };
      }
      fs.renameSync(alias, path.join(aliases, "replacement-link"));
      fs.renameSync(path.join(aliases, "retired"), alias);
      await delay(300);
      assert(
        (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) })).ok,
      );
      result.replacement.recoveryHistoryMs = await history();
    }
    return result;
  } finally {
    ws?.close();
    await stopGateway(child);
    fs.closeSync(log);
    write(`${kind}-${index}.json`, result);
  }
}
try {
  for (let i = 0; i < Number(values.samples); i++) {
    for (const kind of ["base", "head"]) {
      console.log(`START ${kind} ${i}`);
      const r = await run(kind, i);
      results.push(r);
      write("results.json", results);
      console.log(
        JSON.stringify({
          kind,
          index: i,
          health: r.health,
          firstHistoryMs: r.firstHistoryMs,
          source: r.phases.burst?.source,
        }),
      );
    }
  }
  if (values.diagnostic) {
    for (const r of results) {
      assert(
        r.phases.burst.events["alias-parent:rename:named"] > 0,
        "No intended native junction rename callbacks observed",
      );
      if (r.kind === "base") {
        assert(
          r.phases.burst.source.callbackOps > 0,
          "Base did not exercise source validation in native callbacks",
        );
      } else {
        assert.equal(r.phases.burst.source.callbackOps, 0);
        assert(
          r.phases.firstRead.source.realpath > 0,
          "Next read did not validate source identity",
        );
        assert.equal(r.phases.nextRead.source.realpath, 0);
      }
    }
  }
  assert.equal(results.length, Number(values.samples) * 2);
  write("done.json", {
    ok: true,
    mode: Number(values.samples) < 5 ? "smoke" : "campaign",
    runs: results.length,
    driverSha256: createHash("sha256")
      .update(fs.readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    observerSha256: createHash("sha256")
      .update(
        fs.readFileSync(new URL("./lib/session-source-observer-preload.mjs", import.meta.url)),
      )
      .digest("hex"),
    runtimeSha256: createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex"),
  });
} catch (error) {
  write("done.json", { ok: false, error: String(error), stack: error.stack });
  console.error(error);
  process.exitCode = 1;
}
