#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = { timeoutMs: 45000, out: undefined, command: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++i]);
      continue;
    }
    if (arg === "--out") {
      args.out = argv[++i];
      continue;
    }
    if (arg === "--") {
      args.command = argv.slice(i + 1);
      break;
    }
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${args.timeoutMs}`);
  }
  if (args.command.length === 0) {
    throw new Error(
      "Usage: node scripts/agent-exec-safe-probe.mjs [--timeout-ms 45000] [--out file.json] -- <command...>",
    );
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function psSnapshot() {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,ppid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        pgid: Number(match[2]),
        ppid: Number(match[3]),
        command: match[4],
      };
    })
    .filter(Boolean);
}

function lineagePids(processes, rootPid) {
  const collected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (
        collected.has(entry.pid) ||
        collected.has(entry.ppid) ||
        (entry.pgid != null && collected.has(entry.pgid))
      ) {
        if (!collected.has(entry.pid)) {
          collected.add(entry.pid);
          changed = true;
        }
      }
    }
  }
  return collected;
}

function selectRelevantProcesses(processes, rootPid) {
  const lineage = lineagePids(processes, rootPid);
  return processes.filter(
    (entry) =>
      lineage.has(entry.pid) ||
      /(^|\/)openclaw(?:-agent-exec)?(\s|$)/.test(entry.command) ||
      entry.command.includes("agent-exec"),
  );
}

function groupExists(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return false;
  }
  const processes = psSnapshot();
  return processes.some((entry) => entry.pgid === pgid);
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, waitMs) {
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    if (!processExists(pid)) {
      return true;
    }
    await sleep(200);
  }
  return !processExists(pid);
}

function safeUnlink(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function deriveSafeProbeResultPath(jobPath, explicitOut) {
  if (explicitOut) {
    return path.resolve(explicitOut);
  }
  if (!jobPath) {
    return undefined;
  }
  return path.join(path.dirname(jobPath), "safe-probe-result.json");
}

function writeJsonAtomically(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.safe-probe-result.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, serialized);
  fs.renameSync(tempPath, filePath);
  return serialized;
}

async function main() {
  const args = parseArgs(process.argv);
  const command = args.command[0];
  const commandArgs = args.command.slice(1);
  const jobPathIndex = commandArgs.indexOf("--job-path");
  const jobPath = jobPathIndex >= 0 ? path.resolve(commandArgs[jobPathIndex + 1]) : undefined;
  const jobFolder = jobPath ? path.dirname(jobPath) : undefined;
  const lockPath = jobFolder ? path.join(jobFolder, ".agent-exec.lock.json") : undefined;
  const debugPath = jobFolder ? path.join(jobFolder, ".agent-exec-debug.jsonl") : undefined;
  const resultPath = deriveSafeProbeResultPath(jobPath, args.out);
  const jobId = jobFolder ? path.basename(jobFolder) : undefined;
  const agent = commandArgs.includes("--agent")
    ? commandArgs[commandArgs.indexOf("--agent") + 1]
    : undefined;

  if (debugPath) {
    safeUnlink(debugPath);
  }
  if (lockPath) {
    const lock = tryReadJson(lockPath);
    const ownerPid = typeof lock?.pid === "number" ? lock.pid : undefined;
    if (!ownerPid || !processExists(ownerPid)) {
      safeUnlink(lockPath);
    }
  }

  if (resultPath) {
    writeJsonAtomically(resultPath, {
      status: "started",
      final: false,
      result_complete: false,
      command: [command, ...commandArgs],
      job_id: jobId,
      agent,
      timeout_ms: args.timeoutMs,
      started_at: new Date().toISOString(),
      result_path: resultPath,
    });
  }

  const child = spawn(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "pipe",
    detached: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let timedOut = false;
  let termSent = false;
  let killSent = false;
  const startedAt = Date.now();
  const processGroupId = child.pid;

  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const timer = setTimeout(async () => {
    timedOut = true;
    termSent = true;
    if (typeof processGroupId === "number") {
      try {
        process.kill(-processGroupId, "SIGTERM");
      } catch {}
    }
    const exitedAfterTerm = await waitForExit(child.pid, 3000);
    await sleep(400);
    if (!exitedAfterTerm || groupExists(processGroupId)) {
      killSent = true;
      if (typeof processGroupId === "number") {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {}
      }
      await waitForExit(child.pid, 2000);
      await sleep(400);
    }
  }, args.timeoutMs);

  const exit = await exitPromise;
  clearTimeout(timer);

  await sleep(300);
  const processes = selectRelevantProcesses(psSnapshot(), child.pid);
  const lockPayload = lockPath ? tryReadJson(lockPath) : null;
  let staleLockRemoved = false;
  let staleLockRemovalReason = null;
  if (lockPath && fs.existsSync(lockPath)) {
    const ownerPid = typeof lockPayload?.pid === "number" ? lockPayload.pid : undefined;
    if (!ownerPid || !processExists(ownerPid)) {
      staleLockRemoved = safeUnlink(lockPath);
      staleLockRemovalReason = staleLockRemoved
        ? "owner process confirmed gone after probe cleanup"
        : "stale lock detected but unlink failed";
    }
  }

  const result = {
    status: timedOut ? "timed_out" : "completed",
    final: true,
    result_complete: true,
    command: [command, ...commandArgs],
    job_id: jobId,
    agent,
    timeout_ms: args.timeoutMs,
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    pid: child.pid,
    process_group_id: processGroupId,
    exit,
    timed_out: timedOut,
    sigterm_sent: termSent,
    sigkill_sent: killSent,
    remaining_processes: processes,
    remaining_openclaw_processes: processes.filter((entry) =>
      /(^|\/)openclaw(?:-agent-exec)?(\s|$)/.test(entry.command),
    ),
    debug_path: debugPath,
    lock_path: lockPath,
    lock_exists_after_run: lockPath ? fs.existsSync(lockPath) : false,
    lock_payload_after_run: lockPath && fs.existsSync(lockPath) ? tryReadJson(lockPath) : null,
    stale_lock_removed: staleLockRemoved,
    stale_lock_removal_reason: staleLockRemovalReason,
    stdout,
    stderr,
  };

  const serialized = resultPath
    ? writeJsonAtomically(resultPath, result)
    : `${JSON.stringify(result, null, 2)}\n`;
  if (timedOut) {
    process.stderr.write(serialized);
    process.exit(124);
  }
  process.stdout.write(serialized);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
