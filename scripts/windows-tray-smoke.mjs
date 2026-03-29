#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const trayExe = path.join(
  repoRoot,
  "apps",
  "windows",
  "OpenClaw.WindowsTray",
  "bin",
  "Debug",
  "net10.0-windows",
  "OpenClaw.WindowsTray.exe",
);

async function ensureTrayExeExists() {
  try {
    await fs.access(trayExe);
  } catch {
    throw new Error(
      "Tray executable is missing. Run `pnpm windows:tray:build` before `pnpm windows:tray:verify`.",
    );
  }
}

async function withFixtureCli(run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tray-smoke-"));
  const scriptPath = path.join(tempDir, "fake-openclaw.js");
  const cmdPath = path.join(tempDir, "openclaw-fixture.cmd");
  const callsPath = path.join(tempDir, "calls.log");

  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const callsPath = process.env.OPENCLAW_TRAY_FAKE_CALLS;
if (callsPath) {
  fs.appendFileSync(callsPath, args.join(" ") + "\\n", "utf8");
}

const scenario = process.env.OPENCLAW_TRAY_FAKE_SCENARIO || "running";
if (args[0] === "gateway" && args[1] === "status" && args[2] === "--json") {
  if (scenario === "running") {
    process.stdout.write(JSON.stringify({
      service: { loaded: true, runtime: { status: "running" } },
      rpc: { ok: true },
      logs: { directory: "C:\\\\Users\\\\user\\\\.openclaw\\\\logs\\\\gateway" },
      windows: {
        serviceMode: "scheduled-task",
        registrationDetail: "Scheduled Task is registered as OpenClaw Gateway.",
        wsl: {
          wslExeAvailable: true,
          defaultDistroReachable: true,
          systemdEnabled: true
        }
      }
    }));
    process.exit(0);
  }
  if (scenario === "degraded") {
    process.stdout.write(JSON.stringify({
      service: { loaded: true, runtime: { status: "running" } },
      rpc: { ok: true },
      logs: { directory: "C:\\\\Users\\\\user\\\\.openclaw\\\\logs\\\\gateway" },
      windows: {
        serviceMode: "startup-fallback",
        registrationDetail: "Startup-folder login item is installed at C:\\\\Users\\\\user\\\\AppData\\\\Roaming\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs\\\\Startup\\\\OpenClaw Gateway.cmd.",
        degradedReason: "Windows is using the Startup-folder fallback instead of a Scheduled Task.",
        recommendedAction: "Re-run from an elevated PowerShell session if you want Scheduled Task supervision.",
        wsl: {
          wslExeAvailable: true,
          defaultDistroReachable: true,
          systemdEnabled: false,
          recommendedAction: "Enable systemd in /etc/wsl.conf."
        }
      }
    }));
    process.exit(0);
  }
}

if (args[0] === "gateway" && ["start", "stop", "restart"].includes(args[1]) && args[2] === "--json") {
  process.stdout.write(JSON.stringify({
    ok: true,
    message: "Gateway " + args[1] + " completed."
  }));
  process.exit(0);
}

process.stderr.write("unexpected args: " + args.join(" "));
process.exit(1);
`,
    "utf8",
  );

  await fs.writeFile(
    cmdPath,
    `@echo off\r\nnode "%~dp0\\fake-openclaw.js" %*\r\n`,
    "utf8",
  );

  try {
    return await run({
      tempDir,
      scriptPath,
      cmdPath,
      callsPath,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runTrayMode(args, envOverrides) {
  return await new Promise((resolve, reject) => {
    const child = spawn(trayExe, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function verifyScenario(name, fixture) {
  const outputPath = path.join(fixture.tempDir, `${name}.json`);
  const env = {
    OPENCLAW_TRAY_OPENCLAW_PATH: fixture.cmdPath,
    OPENCLAW_TRAY_FAKE_CALLS: fixture.callsPath,
    OPENCLAW_TRAY_FAKE_SCENARIO: name,
  };

  const statusRun = await runTrayMode(["--status-json", "--output", outputPath], env);
  assert.equal(statusRun.code, 0, `status-json exited with ${statusRun.code}: ${statusRun.stderr}`);
  const snapshot = await readJsonFile(outputPath);

  if (name === "running") {
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.Summary, "Gateway is running.");
  } else {
    assert.equal(snapshot.state, "degraded");
    assert.match(snapshot.Summary, /Startup-folder fallback/);
    assert.match(snapshot.RecommendedAction, /elevated PowerShell/i);
  }

  for (const action of ["start", "stop", "restart"]) {
    const lifecyclePath = path.join(fixture.tempDir, `${name}-${action}.json`);
    const lifecycleRun = await runTrayMode(
      ["--lifecycle-json", action, "--output", lifecyclePath],
      env,
    );
    assert.equal(
      lifecycleRun.code,
      0,
      `lifecycle ${action} exited with ${lifecycleRun.code}: ${lifecycleRun.stderr}`,
    );
    const lifecycle = await readJsonFile(lifecyclePath);
    assert.equal(lifecycle.Ok, true);
    assert.match(lifecycle.Summary, new RegExp(`Gateway ${action} completed`, "i"));
  }
}

async function main() {
  await ensureTrayExeExists();
  await withFixtureCli(async (fixture) => {
    await verifyScenario("running", fixture);
    await verifyScenario("degraded", fixture);

    const smokePath = path.join(fixture.tempDir, "smoke.json");
    const smokeRun = await runTrayMode(
      ["--smoke", "--output", smokePath],
      {
        OPENCLAW_TRAY_OPENCLAW_PATH: fixture.cmdPath,
        OPENCLAW_TRAY_FAKE_CALLS: fixture.callsPath,
        OPENCLAW_TRAY_FAKE_SCENARIO: "running",
      },
    );
    assert.equal(smokeRun.code, 0, `smoke exited with ${smokeRun.code}: ${smokeRun.stderr}`);
    const smoke = await readJsonFile(smokePath);
    assert.equal(smoke.Ok, true);
    assert.equal(smoke.State, "running");

    const rawCalls = await fs.readFile(fixture.callsPath, "utf8");
    const calls = new Set(rawCalls.split(/\r?\n/).filter(Boolean));
    assert.ok(calls.has("gateway status --json"));
    assert.ok(calls.has("gateway start --json"));
    assert.ok(calls.has("gateway stop --json"));
    assert.ok(calls.has("gateway restart --json"));
  });

  console.log("windows-tray-smoke: ok");
}

await main();
