import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

async function readJsonWithRetry(filePath, label, attempts = 5, delayMs = 100) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const text = await fs.readFile(filePath, "utf8");
      return JSON.parse(stripBom(text));
    } catch (error) {
      lastError = error;
      if (index < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  throw new Error(`${label} not readable: ${filePath}`, { cause: lastError });
}

async function readTextWithRetry(filePath, label, attempts = 5, delayMs = 100) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      lastError = error;
      if (index < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  throw new Error(`${label} not readable: ${filePath}`, { cause: lastError });
}

function normalizePathForMatch(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .toLowerCase();
}

async function readWindowsProcess(pid) {
  const command = [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue;`,
    "if ($null -eq $process) {",
    "  Write-Output '{}';",
    "} else {",
    "  $process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Depth 4 -Compress;",
    "}",
  ].join(" ");
  const powershellPath = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await execFileAsync(
    powershellPath,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { windowsHide: true, timeout: 10_000 },
  );
  const parsed = JSON.parse(stdout.trim() || "{}");
  if (!parsed?.ProcessId) {
    return { exists: false, commandLine: "", name: "" };
  }
  return {
    exists: true,
    commandLine: String(parsed.CommandLine ?? ""),
    name: String(parsed.Name ?? ""),
  };
}

async function readPosixProcess(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return { exists: false, commandLine: "", name: "" };
  }
  try {
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    return {
      exists: true,
      commandLine: cmdline.replaceAll("\0", " ").trim(),
      name: "",
    };
  } catch {
    return { exists: true, commandLine: "", name: "" };
  }
}

async function readProcessInfo(pid) {
  if (process.platform === "win32") {
    return readWindowsProcess(pid);
  }
  return readPosixProcess(pid);
}

async function main() {
  const repoRoot = process.cwd();
  const servicePath = path.join(
    repoRoot,
    ".openclaw",
    "service",
    "controlled-task-runner-watch-service.json",
  );
  const pidPath = path.join(
    repoRoot,
    ".openclaw",
    "service",
    "controlled-task-runner-watch-service.pid",
  );
  const service = await readJsonWithRetry(servicePath, "controlled task runner watch service");
  const pidText = await readTextWithRetry(pidPath, "controlled task runner watch pid");
  const pid = Number(pidText.trim());

  if (service.schema !== "openclaw.controlled-task-runner-watch-service.v1") {
    throw new Error(`unexpected daemon schema: ${service.schema}`);
  }
  if (service.status !== "running") {
    throw new Error(`daemon is not running: ${service.status}`);
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`invalid daemon pid: ${pidText}`);
  }
  if (service.pid !== pid) {
    throw new Error(`pid mismatch: ${service.pid} != ${pid}`);
  }
  if (
    service.watchScript !==
    path.join(repoRoot, "scripts", "openclaw-controlled-task-runner-watch.mjs")
  ) {
    throw new Error(`unexpected daemon watch script: ${service.watchScript}`);
  }

  const processInfo = await readProcessInfo(pid);
  if (!processInfo.exists) {
    throw new Error(`daemon pid is not alive: ${pid}`);
  }

  const commandLine = normalizePathForMatch(processInfo.commandLine);
  const expectedScript = normalizePathForMatch(service.watchScript);
  if (
    commandLine &&
    !commandLine.includes(expectedScript) &&
    !commandLine.includes(path.basename(expectedScript))
  ) {
    throw new Error(`daemon pid does not run watch script: ${pid}`);
  }

  process.stdout.write(
    [
      "CONTROLLED_TASK_RUNNER_WATCH_DAEMON_CHECK=OK",
      `pid=${pid}`,
      `process=${processInfo.name || "unknown"}`,
      `watchScript=${service.watchScript}`,
    ].join("\n") + "\n",
  );
}

await main().catch((error) => {
  process.stderr.write(
    `controlled task runner watch daemon check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
