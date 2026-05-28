#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_SCHEMA = "openclaw.test-changed-closure.report.v1";
const STATE_DIR_REL = "reports/hermes-agent/state";
const LATEST_REPORT_NAME = "openclaw-test-changed-closure-latest.json";

function ignoreBrokenPipe(stream) {
  stream.on("error", (error) => {
    if (error?.code !== "EPIPE") {
      process.exitCode = 1;
    }
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        stdio: "ignore",
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await sleep(1500);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // no-op
  }
}

function parsePositiveInteger(value, fallback, min, max) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < min) {
    return min;
  }
  if (parsed > max) {
    return max;
  }
  return parsed;
}

function resolveSpawnCommand(command, args) {
  if (process.platform !== "win32") {
    return { command, args };
  }
  if (command === "pnpm") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm", ...args] };
  }
  if (command === "npm") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "npm", ...args] };
  }
  if (command === "yarn") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "yarn", ...args] };
  }
  return { command, args };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const spawnSpec = resolveSpawnCommand(command, args);
    const stdoutChunks = [];
    const stderrChunks = [];
    const env = options.env ? { ...process.env, ...options.env } : process.env;
    let settled = false;
    let timedOut = false;
    let forceResolveTimer = null;
    let timeout;

    const settle = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceResolveTimer) {
        clearTimeout(forceResolveTimer);
      }
      resolve(payload);
    };

    let child;
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: process.cwd(),
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode =
        typeof error === "object" && error !== null && typeof error.code === "string"
          ? error.code
          : "SPAWN_THROWN";
      settle({
        command: [command, ...args].join(" "),
        exitCode: 1,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdoutChunks.join(""),
        stderr: `${stderrChunks.join("")}\n${message}`,
        errorCode,
      });
      return;
    }

    const timeoutMs = options.timeoutMs ?? 180000;
    timeout = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child?.pid ?? 0);
      forceResolveTimer = setTimeout(() => {
        settle({
          command: [command, ...args].join(" "),
          exitCode: 1,
          timedOut: true,
          durationMs: Date.now() - startedAt,
          stdout: stdoutChunks.join(""),
          stderr: `${stderrChunks.join("")}\nforced timeout after process tree terminate request`,
          errorCode: "TIMEOUT",
        });
      }, 15000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (!process.stdout.destroyed && process.stdout.writable) {
        process.stdout.write(chunk);
      }
      stdoutChunks.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      if (!process.stderr.destroyed && process.stderr.writable) {
        process.stderr.write(chunk);
      }
      stderrChunks.push(String(chunk));
    });

    child.once("error", (error) => {
      const errorCode =
        typeof error === "object" && error !== null && typeof error.code === "string"
          ? error.code
          : "SPAWN_ERROR";
      settle({
        command: [command, ...args].join(" "),
        exitCode: 1,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdoutChunks.join(""),
        stderr: `${stderrChunks.join("")}\n${error.message}`,
        errorCode,
      });
    });

    child.once("close", (code) => {
      settle({
        command: [command, ...args].join(" "),
        exitCode: code ?? 1,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        errorCode: code === 0 ? "OK" : "TASK_NON_ZERO_EXIT",
      });
    });
  });
}
async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const repoRoot = process.cwd();
  const stateDir = path.join(repoRoot, STATE_DIR_REL);
  const latestPath = path.join(stateDir, LATEST_REPORT_NAME);
  const fastTimeoutMs = parsePositiveInteger(
    process.env.OPENCLAW_TEST_CHANGED_TIMEOUT_MS,
    780000,
    30000,
    900000,
  );
  const fallbackTimeoutMs = parsePositiveInteger(
    process.env.OPENCLAW_TEST_CHANGED_FALLBACK_TIMEOUT_MS,
    900000,
    30000,
    900000,
  );
  const vitestNoOutputTimeoutMs = parsePositiveInteger(
    process.env.OPENCLAW_TEST_CHANGED_NO_OUTPUT_TIMEOUT_MS ??
      process.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS,
    600000,
    120000,
    900000,
  );
  const closureEnv = {
    OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: String(vitestNoOutputTimeoutMs),
  };

  const attempt1 = await runCommand("pnpm", ["test:changed"], {
    timeoutMs: fastTimeoutMs,
    env: closureEnv,
  });
  const attempts = [
    {
      stage: "changed_default",
      ...attempt1,
    },
  ];

  let finalStage = "changed_default";
  let recovered = false;
  let status = "pass";
  let exitCode = attempt1.exitCode;

  if (attempt1.exitCode !== 0) {
    const attempt2 = await runCommand(
      "node",
      ["scripts/test-projects.mjs", "--changed", "origin/main"],
      {
        timeoutMs: fallbackTimeoutMs,
        env: {
          ...closureEnv,
          OPENCLAW_TEST_PROJECTS_SERIAL: "1",
          OPENCLAW_VITEST_MAX_WORKERS: "1",
        },
      },
    );
    attempts.push({
      stage: "changed_serial_fallback",
      ...attempt2,
    });

    finalStage = "changed_serial_fallback";
    exitCode = attempt2.exitCode;
    recovered = attempt2.exitCode === 0;
    status = recovered ? "recovered" : "failed";
  }

  let failureKind = null;
  if (exitCode !== 0) {
    const anyTimeout = attempts.some((attempt) => attempt.timedOut);
    const anySpawnError = attempts.some(
      (attempt) =>
        typeof attempt.errorCode === "string" &&
        (attempt.errorCode === "EPERM" || attempt.errorCode.startsWith("SPAWN_")),
    );
    failureKind = anyTimeout ? "timeout" : anySpawnError ? "spawn_error" : "test_failure";
  }

  const report = {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    recovered,
    failureKind,
    finalStage,
    exitCode,
    timeouts: {
      fastTimeoutMs,
      fallbackTimeoutMs,
      vitestNoOutputTimeoutMs,
    },
    attempts: attempts.map((attempt) => ({
      stage: attempt.stage,
      command: attempt.command,
      exitCode: attempt.exitCode,
      errorCode: attempt.errorCode ?? null,
      timedOut: attempt.timedOut,
      durationMs: attempt.durationMs,
    })),
    next_safe_task:
      exitCode === 0
        ? "pnpm check"
        : `OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=${String(vitestNoOutputTimeoutMs)} OPENCLAW_TEST_PROJECTS_SERIAL=1 OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test:changed`,
  };

  await writeJson(latestPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (exitCode !== 0) {
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  process.stderr.write(
    `openclaw test changed closure failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
