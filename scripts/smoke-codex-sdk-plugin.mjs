#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeBin = process.execPath;
const runNode = path.join(repoRoot, "scripts", "run-node.mjs");
const openclawBin = path.join(repoRoot, "openclaw.mjs");

const liveSmoke = process.env.OPENCLAW_CODEX_LIVE_SMOKE === "1";
const keepState = process.env.OPENCLAW_CODEX_SMOKE_KEEP_STATE === "1";
const verbose = process.env.OPENCLAW_CODEX_SMOKE_VERBOSE === "1";
const port = Number(process.env.OPENCLAW_CODEX_SMOKE_PORT ?? "19891");
const workspaceCwd = path.resolve(process.env.OPENCLAW_CODEX_SMOKE_CWD ?? repoRoot);
const timeoutMs = Number(process.env.OPENCLAW_CODEX_SMOKE_TIMEOUT_MS ?? "300000");
const providedRoot = process.env.OPENCLAW_CODEX_SMOKE_ROOT;
const smokeRoot = providedRoot
  ? path.resolve(providedRoot)
  : await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-sdk-smoke-"));
const stateDir = path.join(smokeRoot, "state");
const configPath = path.join(smokeRoot, "openclaw.json");

const smokeEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_SKIP_CHANNELS: "1",
  CLAWDBOT_SKIP_CHANNELS: "1",
};

let gatewayProcess;

try {
  step(`using isolated profile ${smokeRoot}`);
  await ensureBuilt();
  await configureProfile();
  await runCli(["codex", "config", "validate"]);
  await runCli(["codex", "doctor", "--record"]);
  await readStatus();

  if (liveSmoke) {
    await runLiveSmoke();
  } else {
    step("live model turn skipped; set OPENCLAW_CODEX_LIVE_SMOKE=1 to enable it");
  }

  step("codex-sdk smoke passed");
} finally {
  await stopGateway();
  if (!keepState && !providedRoot) {
    await rm(smokeRoot, { recursive: true, force: true });
  } else {
    step(`kept smoke profile at ${smokeRoot}`);
  }
}

async function configureProfile() {
  await runCli(["config", "set", "gateway.mode", "local"]);
  await runCli(["config", "set", "gateway.port", String(port)]);
  await runCli(["config", "set", "gateway.bind", "loopback"]);
  await runCli(["plugins", "install", "--link", "./extensions/codex-sdk"]);
  await runCli(["config", "set", "plugins.allow", '["codex-sdk"]']);
  await runCli(["config", "set", "plugins.entries.codex-sdk.config.cwd", workspaceCwd]);
  await runCli(["codex", "configure", "--json"]);
  await runCli(["config", "set", "agents.list[0].runtime.acp.cwd", workspaceCwd]);
}

async function ensureBuilt() {
  await run([nodeBin, runNode, "--version"], { capture: true });
}

async function readStatus() {
  const raw = await runCli(["codex", "status", "--json"], { capture: true });
  const status = JSON.parse(raw);
  step(
    `status read: backend=${status.backend}, routes=${status.routes?.length ?? 0}, sessions=${
      status.sessions?.length ?? 0
    }`,
  );
}

async function runLiveSmoke() {
  gatewayProcess = await startGateway();

  const marker = "STANDALONE_CODEX_GATEWAY_MCP_OK";
  const params = {
    agentId: "codex",
    sessionKey: "agent:codex:main",
    idempotencyKey: `codex-sdk-smoke-${Date.now()}`,
    timeout: timeoutMs - 30000,
    message:
      "Live standalone OpenClaw Codex gateway smoke. Do not inspect files and do not run shell commands. Use the OpenClaw MCP backchannel tool openclaw_status if it is available, then reply with exactly one sentence containing STANDALONE_CODEX_GATEWAY_MCP_OK.",
  };

  const raw = await runCli(
    [
      "gateway",
      "call",
      "agent",
      "--url",
      `ws://127.0.0.1:${port}`,
      "--token",
      "smoke",
      "--expect-final",
      "--timeout",
      String(timeoutMs),
      "--json",
      "--params",
      JSON.stringify(params),
    ],
    { capture: true, timeoutMs: timeoutMs + 30000 },
  );
  const result = JSON.parse(raw);
  const text = result?.result?.payloads?.map((payload) => payload.text ?? "").join("\n") ?? "";
  if (!text.includes(marker)) {
    throw new Error(`live Codex turn did not include ${marker}; got: ${text}`);
  }

  const eventsPath = path.join(stateDir, "codex-sdk", "events", "agent-codex-main.jsonl");
  if (!existsSync(eventsPath)) {
    throw new Error(`missing Codex SDK event log at ${eventsPath}`);
  }
  const events = await readFile(eventsPath, "utf8");
  const completedBackchannel = events
    .split(/\n+/)
    .filter(Boolean)
    .some((line) => {
      const event = JSON.parse(line);
      return event.mappedEvents?.some(
        (mapped) =>
          mapped.title === "openclaw-codex/openclaw_status" && mapped.status === "completed",
      );
    });
  if (!completedBackchannel) {
    throw new Error("Codex did not complete the openclaw_status MCP backchannel tool");
  }
}

async function startGateway() {
  step(`starting loopback Gateway on port ${port}`);
  const child = spawn(
    nodeBin,
    [
      openclawBin,
      "gateway",
      "run",
      "--port",
      String(port),
      "--auth",
      "none",
      "--bind",
      "loopback",
      "--compact",
    ],
    {
      cwd: repoRoot,
      env: smokeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const output = [];
  const remember = (chunk) => {
    const text = chunk.toString();
    if (verbose) {
      process.stdout.write(text);
    }
    output.push(...text.split(/\n/));
    if (output.length > 120) {
      output.splice(0, output.length - 120);
    }
  };
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Gateway did not become ready:\n${output.join("\n")}`));
    }, timeoutMs);
    const cleanup = () => clearTimeout(timer);
    const ready = (chunk) => {
      if (chunk.toString().includes(`listening on ws://127.0.0.1:${port}`)) {
        cleanup();
        child.stdout.off("data", ready);
        child.stderr.off("data", ready);
        resolve();
      }
    };
    child.stdout.on("data", ready);
    child.stderr.on("data", ready);
    child.once("exit", (code, signal) => {
      cleanup();
      reject(new Error(`Gateway exited before ready (${code ?? signal}):\n${output.join("\n")}`));
    });
  });

  return child;
}

async function stopGateway() {
  if (!gatewayProcess || gatewayProcess.exitCode !== null) {
    return;
  }
  gatewayProcess.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      gatewayProcess.kill("SIGKILL");
      resolve();
    }, 5000);
    gatewayProcess.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runCli(args, options = {}) {
  return run([nodeBin, openclawBin, ...args], options);
}

async function run(command, options = {}) {
  const capture = options.capture === true;
  const child = spawn(command[0], command.slice(1), {
    cwd: repoRoot,
    env: smokeEnv,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  let stdout = "";
  let stderr = "";
  if (capture) {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
  }

  const rawCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`command timed out: ${command.join(" ")}`));
    }, options.timeoutMs ?? timeoutMs);
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode ?? 1);
    });
  });
  const code = typeof rawCode === "number" ? rawCode : 1;

  if (code !== 0) {
    const captured = capture ? `\nstdout:\n${stdout}\nstderr:\n${stderr}` : "";
    throw new Error(`command failed (${code}): ${command.join(" ")}${captured}`);
  }
  return stdout.trim();
}

function step(message) {
  process.stderr.write(`[codex-sdk-smoke] ${message}\n`);
}
