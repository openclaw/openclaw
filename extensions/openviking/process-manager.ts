import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { Socket } from "node:net";
import { platform } from "node:os";
import type { spawn } from "node:child_process";

export const IS_WIN = platform() === "win32";

export function waitForHealth(baseUrl: string, timeoutMs: number, intervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() > deadline) {
        reject(new Error(`OpenViking health check timeout at ${baseUrl}`));
        return;
      }
      fetch(`${baseUrl}/health`)
        .then((r) => r.json())
        .then((body: { status?: string }) => {
          if (body?.status === "ok") {
            resolve();
            return;
          }
          setTimeout(tick, intervalMs);
        })
        .catch(() => setTimeout(tick, intervalMs));
    };
    tick();
  });
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function quickTcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

export async function quickHealthCheck(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json().catch(() => ({}))) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function quickRecallPrecheck(
  mode: "local" | "remote",
  baseUrl: string,
  defaultPort: number,
  localProcess: ReturnType<typeof spawn> | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const healthOk = await quickHealthCheck(baseUrl, 500);
  if (healthOk) {
    return { ok: true };
  }

  let host = "127.0.0.1";
  let port = defaultPort;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname) {
      host = parsed.hostname;
    }
    if (parsed.port) {
      const parsedPort = Number(parsed.port);
      if (Number.isFinite(parsedPort) && parsedPort > 0) {
        port = parsedPort;
      }
    }
  } catch {
    // Keep defaults when baseUrl is malformed.
  }

  if (mode === "local") {
    const portOk = await quickTcpProbe(host, port, 200);
    if (!portOk) {
      return { ok: false, reason: `local port unavailable (${host}:${port})` };
    }
    if (localProcess && (localProcess.killed || localProcess.exitCode !== null || localProcess.signalCode !== null)) {
      return { ok: false, reason: "local process is not running" };
    }
    if (localProcess === null) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "health check failed" };
}

export interface ProcessLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

/**
 * Prepare a port for local OpenViking startup.
 *
 * 1. If the port hosts an OpenViking instance (health check passes) → kill it, return same port.
 * 2. If the port is occupied by something else → auto-find the next free port.
 * 3. If the port is free → return it as-is.
 */
export async function prepareLocalPort(
  port: number,
  logger: ProcessLogger,
  maxRetries: number = 10,
): Promise<number> {
  const isOpenViking = await quickHealthCheck(`http://127.0.0.1:${port}`, 2000);
  if (isOpenViking) {
    logger.info?.(`openviking: killing stale OpenViking on port ${port}`);
    await killProcessOnPort(port, logger);
    return port;
  }

  const occupied = await quickTcpProbe("127.0.0.1", port, 500);
  if (!occupied) {
    return port;
  }

  // Port occupied by non-OpenViking process — find next free port
  logger.warn?.(`openviking: port ${port} is occupied by another process, searching for a free port...`);
  for (let candidate = port + 1; candidate <= port + maxRetries; candidate++) {
    if (candidate > 65535) break;
    const taken = await quickTcpProbe("127.0.0.1", candidate, 300);
    if (!taken) {
      logger.info?.(`openviking: using free port ${candidate} instead of ${port}`);
      return candidate;
    }
  }
  throw new Error(
    `openviking: port ${port} is occupied and no free port found in range ${port + 1}-${port + maxRetries}`,
  );
}

function killProcessOnPort(port: number, logger: ProcessLogger): Promise<void> {
  return IS_WIN ? killProcessOnPortWin(port, logger) : killProcessOnPortUnix(port, logger);
}

async function killProcessOnPortWin(port: number, logger: ProcessLogger): Promise<void> {
  try {
    const netstatOut = execSync(
      `netstat -ano | findstr "LISTENING" | findstr ":${port}"`,
      { encoding: "utf-8", shell: "cmd.exe" },
    ).trim();
    if (!netstatOut) return;
    const pids = new Set<number>();
    for (const line of netstatOut.split(/\r?\n/)) {
      const m = line.trim().match(/\s(\d+)\s*$/);
      if (m) pids.add(Number(m[1]));
    }
    for (const pid of pids) {
      if (pid > 0) {
        logger.info?.(`openviking: killing pid ${pid} on port ${port}`);
        try { execSync(`taskkill /PID ${pid} /F`, { shell: "cmd.exe" }); } catch { /* already gone */ }
      }
    }
    if (pids.size) await new Promise((r) => setTimeout(r, 500));
  } catch { /* netstat not available or no stale process */ }
}

async function killProcessOnPortUnix(port: number, logger: ProcessLogger): Promise<void> {
  try {
    let pids: number[] = [];
    try {
      const lsofOut = execSync(`lsof -ti tcp:${port} -s tcp:listen 2>/dev/null || true`, {
        encoding: "utf-8",
        shell: "/bin/sh",
      }).trim();
      if (lsofOut) pids = lsofOut.split(/\s+/).map((s) => Number(s)).filter((n) => n > 0);
    } catch { /* lsof not available */ }
    if (pids.length === 0) {
      try {
        const ssOut = execSync(
          `ss -tlnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p {gsub(/.*pid=/,""); gsub(/,.*/,""); print; exit}'`,
          { encoding: "utf-8", shell: "/bin/sh" },
        ).trim();
        if (ssOut) {
          const n = Number(ssOut);
          if (n > 0) pids = [n];
        }
      } catch { /* ss not available */ }
    }
    for (const pid of pids) {
      logger.info?.(`openviking: killing pid ${pid} on port ${port}`);
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    if (pids.length) await new Promise((r) => setTimeout(r, 500));
  } catch { /* port check failed */ }
}

export function resolvePythonCommand(logger: ProcessLogger): string {
  const defaultPy = IS_WIN ? "python" : "python3";
  let pythonCmd = process.env.OPENVIKING_PYTHON;

  if (!pythonCmd) {
    if (IS_WIN) {
      const { join } = require("node:path") as typeof import("node:path");
      const { homedir } = require("node:os") as typeof import("node:os");
      const envBat = join(homedir(), ".openclaw", "openviking.env.bat");
      if (existsSync(envBat)) {
        try {
          const content = readFileSync(envBat, "utf-8");
          const m = content.match(/set\s+OPENVIKING_PYTHON=(.+)/i);
          if (m?.[1]) pythonCmd = m[1].trim();
        } catch { /* ignore */ }
      }
    } else {
      const { join } = require("node:path") as typeof import("node:path");
      const { homedir } = require("node:os") as typeof import("node:os");
      const envFile = join(homedir(), ".openclaw", "openviking.env");
      if (existsSync(envFile)) {
        try {
          const content = readFileSync(envFile, "utf-8");
          const m = content.match(/OPENVIKING_PYTHON=['"]([^'"]+)['"]/);
          if (m?.[1]) pythonCmd = m[1];
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (!pythonCmd) {
    if (IS_WIN) {
      try {
        pythonCmd = execSync("where python", { encoding: "utf-8", shell: "cmd.exe" }).split(/\r?\n/)[0].trim();
      } catch {
        pythonCmd = "python";
      }
    } else {
      try {
        pythonCmd = execSync("command -v python3 || which python3", {
          encoding: "utf-8",
          env: process.env,
          shell: "/bin/sh",
        }).trim();
      } catch {
        pythonCmd = "python3";
      }
    }
  }

  if (pythonCmd === defaultPy) {
    logger.info?.(
      `openviking: 未解析到 ${defaultPy} 路径，将用 "${defaultPy}"。若 openviking 在自定义 Python 下，请设置 OPENVIKING_PYTHON` +
      (IS_WIN ? ' 或 call "%USERPROFILE%\\.openclaw\\openviking.env.bat"' : " 或 source ~/.openclaw/openviking.env"),
    );
  }

  return pythonCmd;
}
