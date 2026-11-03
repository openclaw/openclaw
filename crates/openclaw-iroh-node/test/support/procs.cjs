// Child processes for tests: a dev iroh-relay on a free loopback port in its own tmp dir, and
// node helper scripts that print one JSON line. Only pids spawned here are ever signalled.
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

/** Path of the iroh-relay 1.4.1 binary: IROH_RELAY_BIN or ~/.cargo/bin/iroh-relay, if present. */
function relayBin() {
  const bin = process.env.IROH_RELAY_BIN || path.join(os.homedir(), ".cargo/bin/iroh-relay");
  return fs.existsSync(bin) ? bin : null;
}

/** Returns a TCP port that was free on 127.0.0.1 a moment ago. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Starts a dev relay (plain HTTP) on a free port; resolves { url, dir, stop() }. */
async function startRelay() {
  const bin = relayBin();
  if (!bin) {
    throw new Error("iroh-relay not found (set IROH_RELAY_BIN)");
  }
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-iroh-relay-"));
  const cfg = path.join(dir, "relay.toml");
  fs.writeFileSync(
    cfg,
    `enable_relay = true\nhttp_bind_addr = "127.0.0.1:${port}"\nenable_quic_addr_discovery = false\nenable_metrics = false\n`,
  );
  const log = fs.openSync(path.join(dir, "relay.log"), "a");
  const child = spawn(bin, ["--dev", "-c", cfg], { stdio: ["ignore", log, log] });
  fs.closeSync(log);
  try {
    await waitTcp(port, 10000);
  } catch (e) {
    await stopChild(child);
    throw e;
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    dir,
    stop: async () => {
      await stopChild(child);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Polls until something listens on 127.0.0.1:port.
async function waitTcp(port, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const ok = await new Promise((r) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.destroy();
        r(true);
      });
      s.on("error", () => r(false));
    });
    if (ok) {
      return;
    }
    if (Date.now() > end) {
      throw new Error("relay did not start on " + port);
    }
    await delay(100);
  }
}

/** Spawns a node script that prints one JSON line first; resolves { info, child, stop() }. */
function spawnJsonLine(script, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    let resolved = false;
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0 && !resolved) {
        resolved = true;
        resolve({ info: JSON.parse(buf.slice(0, i)), child, stop: () => stopChild(child) });
      }
    });
    child.on("exit", (code) => resolved || reject(new Error(`${script} exited ${code}: ${err}`)));
  });
}

/** SIGTERMs one child we own and waits (at most 3 s, then SIGKILL). */
function stopChild(child) {
  return new Promise((r) => {
    if (child.exitCode !== null || child.signalCode) {
      r();
      return;
    }
    const t = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(t);
      r();
    });
    child.kill("SIGTERM");
  });
}

module.exports = { relayBin, freePort, startRelay, spawnJsonLine, stopChild };
