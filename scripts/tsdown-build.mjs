#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const extraArgs = process.argv.slice(2);
const INEFFECTIVE_DYNAMIC_IMPORT_RE = /\[INEFFECTIVE_DYNAMIC_IMPORT\]/;
const UNRESOLVED_IMPORT_RE = /\[UNRESOLVED_IMPORT\]/;
const ANSI_ESCAPE_RE = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g");
const LIVE_REBUILD_OVERRIDE_ENV = "OPENCLAW_ALLOW_LIVE_REBUILD";

function removeDistPluginNodeModulesSymlinks(rootDir) {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return;
  }

  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeModulesPath = path.join(extensionsDir, dirent.name, "node_modules");
    try {
      if (fs.lstatSync(nodeModulesPath).isSymbolicLink()) {
        fs.rmSync(nodeModulesPath, { force: true, recursive: true });
      }
    } catch {
      // Skip missing or unreadable paths so the build can proceed.
    }
  }
}

function pruneStaleRuntimeSymlinks() {
  const cwd = process.cwd();
  // runtime-postbuild stages plugin-owned node_modules into dist/ and links the
  // dist-runtime overlay back to that tree. Remove only those symlinks up front
  // so tsdown's clean step cannot traverse stale runtime overlays on rebuilds.
  removeDistPluginNodeModulesSymlinks(path.join(cwd, "dist"));
  removeDistPluginNodeModulesSymlinks(path.join(cwd, "dist-runtime"));
}

pruneStaleRuntimeSymlinks();

function normalizeForProcessMatch(value) {
  return value.replace(/\\/g, "/").toLowerCase();
}

function resolvePnpmRunner() {
  const nodeDir = path.dirname(process.execPath);

  if (process.platform === "win32") {
    const pnpmPs1 = path.join(nodeDir, "node_modules", "corepack", "shims", "pnpm.ps1");
    const pnpmCmd = path.join(nodeDir, "node_modules", "corepack", "shims", "pnpm.cmd");
    const pnpmExe = path.join(nodeDir, "pnpm.exe");
    if (fs.existsSync(pnpmPs1)) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", pnpmPs1, "exec", "tsdown"],
        shell: false,
      };
    }
    if (fs.existsSync(pnpmCmd)) {
      return {
        command: pnpmCmd,
        args: ["exec", "tsdown"],
        shell: true,
      };
    }
    if (fs.existsSync(pnpmExe)) {
      return {
        command: pnpmExe,
        args: ["exec", "tsdown"],
        shell: false,
      };
    }
  }

  return {
    command: "pnpm",
    args: ["exec", "tsdown"],
    shell: process.platform === "win32",
  };
}

function listLiveGatewayProcesses(cwd) {
  const gatewayEntry = normalizeForProcessMatch(path.join(cwd, "dist", "index.js"));
  try {
    if (process.platform === "win32") {
      const psScript = [
        `$target = ${JSON.stringify(gatewayEntry)}`,
        "Get-CimInstance Win32_Process |",
        "  Where-Object {",
        "    $_.CommandLine -and",
        "    ($_.CommandLine.ToLower() -replace '\\\\', '/').Contains($target) -and",
        "    $_.CommandLine -match '(^|\\s)gateway(\\s|$)'",
        "  } |",
        "  Select-Object -ExpandProperty ProcessId",
      ].join("\n");
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
        {
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      if (result.status !== 0) {
        return null;
      }
      return (result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }

    const result = spawnSync("ps", ["-ax", "-o", "pid=,command="], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0) {
      return null;
    }
    return (result.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        const lower = line.toLowerCase();
        return lower.includes(gatewayEntry) && /\bgateway\b/.test(lower);
      })
      .map((line) => line.split(/\s+/, 1)[0]);
  } catch {
    return null;
  }
}

function assertSafeToRebuild(cwd) {
  if (process.env[LIVE_REBUILD_OVERRIDE_ENV] === "1") {
    return;
  }
  const liveGatewayPids = listLiveGatewayProcesses(cwd);
  if (!liveGatewayPids || liveGatewayPids.length === 0) {
    return;
  }
  console.error(
    [
      "Refusing to rebuild OpenClaw dist while the live gateway is still running from this repo.",
      `Detected gateway PID(s): ${liveGatewayPids.join(", ")}`,
      "In-place rebuilds can delete hashed chunks/plugin-sdk files under a running process and cause ERR_MODULE_NOT_FOUND.",
      "Stop the gateway first or use scripts/redeploy-gateway-safe.ps1.",
      `Set ${LIVE_REBUILD_OVERRIDE_ENV}=1 only if you intentionally accept the live-rebuild risk.`,
    ].join("\n"),
  );
  process.exit(1);
}

assertSafeToRebuild(process.cwd());

function findFatalUnresolvedImport(lines) {
  for (const line of lines) {
    if (!UNRESOLVED_IMPORT_RE.test(line)) {
      continue;
    }

    const normalizedLine = line.replace(ANSI_ESCAPE_RE, "");
    if (!normalizedLine.includes("extensions/") && !normalizedLine.includes("node_modules/")) {
      return normalizedLine;
    }
  }

  return null;
}

const pnpmRunner = resolvePnpmRunner();

const result = spawnSync(
  pnpmRunner.command,
  [...pnpmRunner.args, "--config-loader", "unrun", "--logLevel", logLevel, ...extraArgs],
  {
    encoding: "utf8",
    stdio: "pipe",
    shell: pnpmRunner.shell,
    windowsVerbatimArguments: pnpmRunner.windowsVerbatimArguments,
  },
);

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
if (stdout) {
  process.stdout.write(stdout);
}
if (stderr) {
  process.stderr.write(stderr);
}

if (result.status === 0 && INEFFECTIVE_DYNAMIC_IMPORT_RE.test(`${stdout}\n${stderr}`)) {
  console.error(
    "Build emitted [INEFFECTIVE_DYNAMIC_IMPORT]. Replace transparent runtime re-export facades with real runtime boundaries.",
  );
  process.exit(1);
}

const fatalUnresolvedImport =
  result.status === 0 ? findFatalUnresolvedImport(`${stdout}\n${stderr}`.split("\n")) : null;

if (fatalUnresolvedImport) {
  console.error(`Build emitted [UNRESOLVED_IMPORT] outside extensions: ${fatalUnresolvedImport}`);
  process.exit(1);
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
