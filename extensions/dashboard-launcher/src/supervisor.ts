import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { dashboardPath, intentFile, logPaths, pidFile } from "./paths.js";

export class BootGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootGuardError";
  }
}

export type Intent = "running" | "stopped";

export interface SupervisorEnv {
  port: number;
  publicMode: boolean;
  authToken?: string;
  dev?: boolean;
}

export interface SpawnOnceResult {
  child: ChildProcess;
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface SpawnDeps {
  spawnFn?: typeof spawn;
}

const HEX_TOKEN_RE = /^[0-9a-fA-F]+$/;

export function validateBootGuard(env: SupervisorEnv): void {
  if (!env.publicMode) {
    return;
  }
  const token = env.authToken ?? "";
  if (token.length < 32 || !HEX_TOKEN_RE.test(token)) {
    throw new BootGuardError(
      "MISSION_CONTROL_PUBLIC=1 requires MC_AUTH_TOKEN to be at least 32 hex characters. Refusing to spawn.",
    );
  }
}

const BACKOFF_LADDER = [1, 2, 4, 8, 60] as const;
const CLEAN_UPTIME_RESET_MS = 5 * 60 * 1000;

export interface BackoffState {
  consecutiveCrashes: number;
  lastUptimeMs: number;
}

/** Pick the next restart delay (seconds) given the previous run's uptime. */
export function nextBackoff(state: BackoffState): {
  delaySeconds: number;
  nextState: BackoffState;
} {
  if (state.lastUptimeMs >= CLEAN_UPTIME_RESET_MS) {
    return {
      delaySeconds: BACKOFF_LADDER[0],
      nextState: { consecutiveCrashes: 1, lastUptimeMs: 0 },
    };
  }
  const idx = Math.min(state.consecutiveCrashes, BACKOFF_LADDER.length - 1);
  const delaySeconds = BACKOFF_LADDER[idx];
  return {
    delaySeconds,
    nextState: { consecutiveCrashes: state.consecutiveCrashes + 1, lastUptimeMs: 0 },
  };
}

function buildChildEnv(supervisorEnv: SupervisorEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(supervisorEnv.port) };
  if (supervisorEnv.publicMode) {
    env.MISSION_CONTROL_PUBLIC = "1";
  }
  if (supervisorEnv.authToken) {
    env.MC_AUTH_TOKEN = supervisorEnv.authToken;
  }
  return env;
}

function ensureDir(file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function spawnOnce(
  cwd: string,
  supervisorEnv: SupervisorEnv,
  deps: SpawnDeps = {},
): SpawnOnceResult {
  validateBootGuard(supervisorEnv);
  const spawnFn = deps.spawnFn ?? spawn;
  const command = supervisorEnv.dev ? "npm" : "node";
  const args = supervisorEnv.dev ? ["run", "dev"] : ["server.js"];
  const opts: SpawnOptions = {
    cwd,
    env: buildChildEnv(supervisorEnv),
    stdio: ["ignore", "pipe", "pipe"],
  };

  const { outLog, errLog } = logPaths();
  ensureDir(outLog);
  const outStream = createWriteStream(outLog, { flags: "a" });
  const errStream = createWriteStream(errLog, { flags: "a" });

  const child = spawnFn(command, args, opts);
  child.stdout?.pipe(outStream);
  child.stderr?.pipe(errStream);

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(new BootGuardError(`Failed to spawn '${command}': binary not found on PATH.`));
        } else {
          reject(err);
        }
      });
      child.on("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  return { child, exitPromise };
}

export function readIntent(): Intent {
  try {
    const raw = readFileSync(intentFile(), "utf8").trim();
    return raw === "stopped" ? "stopped" : "running";
  } catch {
    return "stopped";
  }
}

export function writeIntent(intent: Intent): void {
  const file = intentFile();
  ensureDir(file);
  writeFileSync(file, intent);
}

export function writePid(pid: number): void {
  const file = pidFile();
  ensureDir(file);
  writeFileSync(file, String(pid));
}

export function readPid(): number | null {
  try {
    const raw = readFileSync(pidFile(), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function clearPid(): void {
  try {
    unlinkSync(pidFile());
  } catch {
    /* already gone */
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface RunSupervisorOptions {
  env: SupervisorEnv;
  /** Override path resolution for tests. */
  cwd?: string;
  /** Inject deterministic dependencies for tests. */
  deps?: SpawnDeps & {
    sleep?: (ms: number) => Promise<void>;
    intentReader?: () => Intent;
    now?: () => number;
  };
}

export async function runSupervisor(opts: RunSupervisorOptions): Promise<void> {
  const env = opts.env;
  validateBootGuard(env);
  const cwd = opts.cwd ?? dashboardPath();
  const deps = opts.deps ?? {};
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const readIntentFn = deps.intentReader ?? readIntent;
  const now = deps.now ?? Date.now;

  writeIntent("running");

  let state: BackoffState = { consecutiveCrashes: 0, lastUptimeMs: 0 };

  while (readIntentFn() === "running") {
    const startedAt = now();
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      const { child, exitPromise } = spawnOnce(cwd, env, deps);
      if (child.pid) {
        writePid(child.pid);
      }
      exit = await exitPromise;
    } catch (err) {
      clearPid();
      throw err;
    }

    clearPid();
    if (readIntentFn() === "stopped") {
      return;
    }

    state.lastUptimeMs = now() - startedAt;
    const { delaySeconds, nextState } = nextBackoff(state);
    state = nextState;
    void exit;
    await sleep(delaySeconds * 1000);
  }
}

export interface StopOptions {
  /** Total milliseconds to wait for SIGTERM to take effect before SIGKILL. */
  termGraceMs?: number;
  /** Inject signalling for tests. */
  signal?: (pid: number, sig: NodeJS.Signals | 0) => void;
  /** Inject liveness probe for tests. */
  alive?: (pid: number) => boolean;
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export async function stopSupervisor(
  opts: StopOptions = {},
): Promise<{ stopped: boolean; pid: number | null }> {
  writeIntent("stopped");
  const pid = readPid();
  if (pid == null) {
    return { stopped: true, pid: null };
  }

  const grace = opts.termGraceMs ?? 10_000;
  const sendSignal = opts.signal ?? ((p, s) => process.kill(p, s));
  const isAlive = opts.alive ?? isProcessAlive;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  try {
    sendSignal(pid, "SIGTERM");
  } catch {
    clearPid();
    return { stopped: true, pid };
  }

  const pollMs = Math.min(250, grace);
  let waited = 0;
  while (waited < grace) {
    if (!isAlive(pid)) {
      clearPid();
      return { stopped: true, pid };
    }
    await sleep(pollMs);
    waited += pollMs;
  }

  if (isAlive(pid)) {
    try {
      sendSignal(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
  clearPid();
  return { stopped: true, pid };
}
