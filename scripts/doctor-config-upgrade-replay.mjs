#!/usr/bin/env node
// Replay the shipped July config shape through the dist-backed CLI in isolated state.
// Requires a source checkout with its pnpm dependencies; this is not a packaged CLI command.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform === "win32") {
  throw new Error("Run this process-group-isolated replay on macOS, Linux, or WSL.");
}
fs.mkdirSync(path.join(root, ".local"), { recursive: true });
const proof = fs.mkdtempSync(path.join(root, ".local", "doctor-upgrade-"));
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "test/fixtures/doctor-2026.7.1.json"), "utf8"),
);
console.log(`Replay evidence: ${proof}`);

async function prepareState(directory, config) {
  fs.mkdirSync(path.join(directory, "home"), { recursive: true });
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await promisify(server.close.bind(server))();
  const isolated = structuredClone(config);
  isolated.gateway.port = port;
  isolated.logging = { file: path.join(directory, "gateway.log") };
  const configPath = path.join(directory, "openclaw.json");
  fs.writeFileSync(configPath, `${JSON.stringify(isolated, null, 2)}\n`);
  return {
    configPath,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: "en_US.UTF-8",
      HOME: path.join(directory, "home"),
      OPENCLAW_STATE_DIR: directory,
      OPENCLAW_CONFIG_PATH: configPath,
      NO_COLOR: "1",
      CI: "true",
    },
  };
}

function run(state, directory, name, args, expected = 0) {
  console.log(`${name}: pnpm openclaw ${args.join(" ")}`);
  const fd = fs.openSync(path.join(directory, `${name}.log`), "w");
  let result;
  try {
    result = spawnSync("pnpm", ["openclaw", ...args], {
      cwd: root,
      env: state.env,
      stdio: ["ignore", fd, fd],
      timeout: 15 * 60_000,
    });
  } finally {
    fs.closeSync(fd);
  }
  if (result.error) {
    throw result.error;
  }
  console.log(`${name}: exit ${result.status}`);
  assert.equal(result.status, expected, `Inspect ${path.join(directory, `${name}.log`)}`);
}

async function startup(directory, config, requireReady = true) {
  const state = await prepareState(directory, config);
  const output = fs.createWriteStream(path.join(directory, "startup.log"));
  const child = spawn("pnpm", ["openclaw", "gateway", "run"], {
    cwd: root,
    env: state.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  const stop = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  };
  let timer;
  let text = "";
  let interrupt;
  try {
    const ready = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Startup timed out; inspect ${directory}`)),
        180_000,
      );
      interrupt = () => reject(new Error(`Replay interrupted; evidence remains at ${proof}`));
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      child.once("error", reject);
      output.once("error", reject);
      child.once("exit", () => resolve(false));
      const capture = (chunk) => {
        output.write(chunk);
        text += chunk.toString();
        if (text.includes("[gateway] ready")) {
          resolve(true);
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
    });
    console.log(
      `startup ${ready ? "ready" : `exited ${child.exitCode} before ready`}: ${directory}`,
    );
    if (requireReady) {
      assert.equal(ready, true, `Inspect ${directory}`);
    }
  } finally {
    clearTimeout(timer);
    stop("SIGTERM");
    const shutdown = setTimeout(() => stop("SIGKILL"), 120_000);
    await closed.catch(() => undefined).finally(() => clearTimeout(shutdown));
    if (interrupt) {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
    await new Promise((resolve) => {
      output.end(resolve);
    });
  }
}

for (const name of ["reported", "tts-sibling"]) {
  const directory = path.join(proof, name);
  const config = structuredClone(fixture);
  if (name === "tts-sibling") {
    config.messages = {
      tts: {
        prefsPath: path.join(directory, "unused-tts-prefs.json"),
        personas: { narrator: { prompt: { style: "calm" } } },
      },
    };
  }
  const state = await prepareState(path.join(directory, "state"), config);
  fs.copyFileSync(state.configPath, path.join(directory, "original.json"));
  run(state, directory, "validate-before", ["config", "validate"], 1);
  await startup(path.join(directory, "startup-before"), config, false);
  run(state, directory, "doctor-pass1", ["doctor", "--fix", "--non-interactive"]);
  const first = fs.readFileSync(state.configPath, "utf8");
  fs.writeFileSync(path.join(directory, "pass1.json"), first);
  run(state, directory, "validate-pass1", ["config", "validate"]);
  run(state, directory, "doctor-pass2", ["doctor", "--fix", "--non-interactive"]);
  const second = fs.readFileSync(state.configPath, "utf8");
  fs.writeFileSync(path.join(directory, "pass2.json"), second);
  assert.equal(second, first, `Second Doctor pass changed ${name}; inspect ${directory}`);
  console.log(`${name}: valid after one pass; second pass left config bytes unchanged`);
  await startup(path.join(directory, "startup"), JSON.parse(first));
}
