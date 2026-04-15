#!/usr/bin/env node

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCLAW_HOST_CLI_TIMEOUT_MS || "15000");
const OPENCLAW_BIN = process.env.OPENCLAW_BIN?.trim() || "openclaw";

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function ensureTimeoutMs(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 15000;
  }
  return Math.floor(value);
}

function killProcessTree(pid, detached, signal) {
  if (!pid) {
    return;
  }

  try {
    process.kill(detached ? -pid : pid, signal);
  } catch {
    // Process already exited.
  }
}

function runOpenClaw(args, options = {}) {
  const timeoutMs = ensureTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const detached = process.platform !== "win32";
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let timedOut = false;
    let settled = false;
    let killTimer = null;

    const child = spawn(OPENCLAW_BIN, args, {
      detached,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    const finish = (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      const elapsedMs = Date.now() - startedAt;
      resolve({
        args,
        status,
        signal,
        error: spawnError,
        timedOut,
        timeoutMs,
        elapsedMs,
        stdout,
        stderr,
        combined: `${stderr}${stderr && stdout ? "\n" : ""}${stdout}`,
      });
    };

    child.on("error", (error) => {
      spawnError = error;
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      spawnError = Object.assign(new Error(`Command timed out after ${timeoutMs}ms`), {
        code: "ETIMEDOUT",
      });
      killProcessTree(child.pid, detached, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(child.pid, detached, "SIGKILL");
      }, 500);
      killTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.on("close", (status, signal) => {
      finish(status, signal);
    });
  });
}

function assertCommandSucceeded(result, label) {
  if (result.timedOut) {
    fail(`${label} timed out after ${result.timeoutMs}ms`, { result });
  }
  if (result.error) {
    fail(`${label} failed to start`, { result });
  }
  if (result.signal) {
    fail(`${label} exited by signal ${result.signal}`, { result });
  }
  if (result.status !== 0) {
    fail(`${label} exited with status ${result.status}`, { result });
  }
}

function extractVersion(text) {
  const match = text.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?\b/);
  return match?.[0] ?? null;
}

function extractProfiledPlugins(text) {
  const plugins = [];
  const regex = /^\[plugin-load-profile\] phase=([^\s]+) plugin=([^\s]+)\s/mg;
  let match = regex.exec(text);
  while (match) {
    plugins.push({ phase: match[1], plugin: match[2] });
    match = regex.exec(text);
  }
  return plugins;
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        return JSON.parse(candidate);
      }
    }
  }

  return null;
}

function assertOnlyOwnerPlugin(result, label) {
  const profiled = extractProfiledPlugins(result.combined);
  const unique = [...new Set(profiled.map((entry) => entry.plugin))];
  if (unique.length === 0) {
    fail(`${label} did not emit any plugin-load-profile lines`, { result });
  }
  if (unique.length !== 1 || unique[0] !== "memory-lancedb-pro") {
    fail(`${label} loaded unexpected cli-metadata plugins`, {
      plugins: profiled,
      result,
    });
  }
  return {
    plugins: unique,
    phases: [...new Set(profiled.map((entry) => entry.phase))],
  };
}

function buildSummary(results) {
  return {
    openclawBin: OPENCLAW_BIN,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    checks: results,
  };
}

async function main() {
  const checks = [];

  const versionResult = await runOpenClaw(["memory-pro", "version"]);
  assertCommandSucceeded(versionResult, "memory-pro version");
  const version = extractVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (!version) {
    fail("memory-pro version did not print a version string", { result: versionResult });
  }
  checks.push({
    name: "memory-pro version",
    elapsedMs: versionResult.elapsedMs,
    version,
  });

  const statsResult = await runOpenClaw(["memory-pro", "stats", "--json"]);
  assertCommandSucceeded(statsResult, "memory-pro stats --json");
  const statsJson = extractFirstJsonObject(statsResult.combined);
  if (!statsJson || typeof statsJson !== "object") {
    fail("memory-pro stats --json did not return parseable JSON", { result: statsResult });
  }
  const fts = statsJson?.retrieval?.fts;
  if (!fts || typeof fts.available !== "boolean") {
    fail("memory-pro stats --json missing retrieval.fts status", { statsJson, result: statsResult });
  }
  checks.push({
    name: "memory-pro stats --json",
    elapsedMs: statsResult.elapsedMs,
    retrievalMode: statsJson?.retrieval?.mode ?? null,
    fts,
  });

  const profiledVersion = await runOpenClaw(["memory-pro", "version"], {
    env: { OPENCLAW_PLUGIN_LOAD_PROFILE: "1" },
  });
  assertCommandSucceeded(profiledVersion, "profiled memory-pro version");
  const versionProfile = assertOnlyOwnerPlugin(profiledVersion, "profiled memory-pro version");
  checks.push({
    name: "profiled memory-pro version",
    elapsedMs: profiledVersion.elapsedMs,
    profiledPlugins: versionProfile.plugins,
    profilePhases: versionProfile.phases,
  });

  const profiledStats = await runOpenClaw(["memory-pro", "stats", "--json"], {
    env: { OPENCLAW_PLUGIN_LOAD_PROFILE: "1" },
  });
  assertCommandSucceeded(profiledStats, "profiled memory-pro stats --json");
  const statsProfile = assertOnlyOwnerPlugin(profiledStats, "profiled memory-pro stats --json");
  checks.push({
    name: "profiled memory-pro stats --json",
    elapsedMs: profiledStats.elapsedMs,
    profiledPlugins: statsProfile.plugins,
    profilePhases: statsProfile.phases,
  });

  console.log(JSON.stringify(buildSummary(checks), null, 2));
}

try {
  main();
} catch (error) {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    details: error && typeof error === "object" && "details" in error ? error.details : undefined,
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
