#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runWatchMain } from "./watch-node.mjs";

const WINDOWS_NATIVE_BASE_ARGS = [
  "gateway",
  "run",
  "--bind",
  "loopback",
  "--port",
  "18789",
  "--allow-unconfigured",
];

export function buildGatewayWatchArgs(params = {}) {
  const platform = params.platform ?? process.platform;
  const passthroughArgs = params.args ?? process.argv.slice(2);
  if (platform === "win32") {
    return [...WINDOWS_NATIVE_BASE_ARGS, ...passthroughArgs];
  }
  return ["gateway", "--force", ...passthroughArgs];
}

function stopWindowsGatewayDaemonBestEffort(params) {
  if (params.platform !== "win32") {
    return;
  }
  try {
    params.spawnSync(params.execPath, ["openclaw.mjs", "gateway", "stop"], {
      cwd: params.cwd,
      env: params.env,
      stdio: "inherit",
    });
  } catch {
    // Best-effort only: ignore stop failures so watch mode can still start.
  }
}

export async function runGatewayWatchMain(params = {}) {
  const runtimeProcess = params.process ?? process;
  const deps = {
    platform: params.platform ?? process.platform,
    spawnSync: params.spawnSync ?? spawnSync,
    execPath: params.execPath ?? runtimeProcess.execPath ?? process.execPath,
    cwd: params.cwd ?? process.cwd(),
    env: params.env ? { ...params.env } : { ...process.env },
    args: params.args ?? process.argv.slice(2),
    process: runtimeProcess,
    spawn: params.spawn,
    now: params.now,
  };

  stopWindowsGatewayDaemonBestEffort(deps);

  return await runWatchMain({
    args: buildGatewayWatchArgs({ platform: deps.platform, args: deps.args }),
    cwd: deps.cwd,
    env: deps.env,
    process: deps.process,
    spawn: deps.spawn,
    now: deps.now,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runGatewayWatchMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
