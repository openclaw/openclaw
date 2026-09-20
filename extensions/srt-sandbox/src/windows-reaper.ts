// Windows per-scope reaper + Job-Object worker client (Stage S6, design v8 §5).
//
// The Windows analogue of the POSIX ScopeChildReaper. Windows has no process
// groups / signals, so containment is delegated to a plugin-owned worker
// (windows-worker-source.ts) that holds a Job Object with KILL_ON_JOB_CLOSE:
//   - runShellCommand execs run THROUGH the worker (buffered RPC); every
//     srt-win tree they launch is a job member, so worker exit reaps them.
//     The worker force-exits on Gateway death (parent-pid watch) → job closes
//     → whole tree reaped (verified on real Windows ARM64: reap-on-worker-crash,
//     reap-on-gateway-crash).
//   - the persistent fs-bridge pin owner is spawned directly (its stdio is a
//     streaming RPC channel the PinOwnerClient drives); srt-win's own broker
//     kill-on-close job reaps its runner+child on broker death, and scope
//     teardown taskkills it.
// Scope teardown / dispose shuts the worker down (job reaps command trees) and
// force-kills any tracked broker with `taskkill /T /F` (kills the whole tree).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { PersistentChildHandle } from "./scope-reaper.js";
import { buildWindowsWorkerArgv, windowsWorkerEnv } from "./windows-worker-source.js";

/** Buffered result of one command executed inside the sandbox via the worker. */
export type WindowsExecResult = {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
};

export type WindowsExecParams = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin?: Buffer | string;
  timeoutMs: number;
};

/** The worker process is gone (exited / EOF / disposed); the call failed closed. */
export class WindowsWorkerDeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsWorkerDeadError";
  }
}

/** Worker spawn / health-check failed; the scope has no sandboxed exec path. */
export class WindowsWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsWorkerUnavailableError";
  }
}

type WorkerResponse = { id?: unknown; ok?: boolean; error?: string } & Record<string, unknown>;
type PendingCall = {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_READY_TIMEOUT_MS = 20_000;

/** Force-kill a process tree by pid (Windows has no process-group signal). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: 15_000 });
  } catch {
    // Already gone / nothing we can do — terminal either way.
  }
}

export class WindowsScopeReaper {
  private worker: ChildProcess | undefined;
  private spawning: Promise<ChildProcess> | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readyResolve: (() => void) | undefined;
  private disposed = false;
  /** Tracked broker pids (pin owners spawned directly) for teardown taskkill. */
  private readonly tracked = new Set<number>();
  private readonly readyTimeoutMs: number;

  constructor(opts?: { readyTimeoutMs?: number }) {
    this.readyTimeoutMs = opts?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  get isRunning(): boolean {
    return this.worker !== undefined;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private async ensureWorker(): Promise<ChildProcess> {
    if (this.disposed) {
      throw new WindowsWorkerDeadError("windows scope reaper has been disposed");
    }
    if (this.worker) {
      return this.worker;
    }
    if (!this.spawning) {
      this.spawning = this.spawnWorker().finally(() => {
        this.spawning = undefined;
      });
    }
    return this.spawning;
  }

  private async spawnWorker(): Promise<ChildProcess> {
    const argv = buildWindowsWorkerArgv();
    const child = spawn(argv[0]!, argv.slice(1), {
      env: windowsWorkerEnv(process.pid),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.attachWorker(child);
    try {
      await this.waitForReady();
    } catch (error) {
      this.onWorkerGone(child, "worker failed its startup health-check");
      throw error instanceof WindowsWorkerUnavailableError
        ? error
        : new WindowsWorkerUnavailableError(error instanceof Error ? error.message : String(error));
    }
    return child;
  }

  private attachWorker(child: ChildProcess): void {
    this.worker = child;
    this.buffer = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.onStdout(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stdout?.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.on("exit", (code, signal) => {
      this.onWorkerGone(
        child,
        `windows worker exited (code=${String(code)}, signal=${String(signal)})`,
      );
    });
    child.on("error", (error: Error) => {
      this.onWorkerGone(child, `windows worker failed to launch: ${error.message}`);
    });
  }

  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyResolve = undefined;
        reject(
          new WindowsWorkerUnavailableError(
            `windows worker did not report ready within ${this.readyTimeoutMs}ms`,
          ),
        );
      }, this.readyTimeoutMs);
      this.readyResolve = () => {
        clearTimeout(timer);
        this.readyResolve = undefined;
        resolve();
      };
    });
  }

  private onStdout(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line === "") {
        continue;
      }
      let message: WorkerResponse;
      try {
        message = JSON.parse(line) as WorkerResponse;
      } catch {
        continue; // non-JSON diagnostics on the wrong stream
      }
      if (message.ready === true) {
        this.readyResolve?.();
        continue;
      }
      const id = message.id;
      if (typeof id !== "number") {
        continue;
      }
      const call = this.pending.get(id);
      if (!call) {
        continue;
      }
      this.pending.delete(id);
      clearTimeout(call.timer);
      if (message.ok === true) {
        call.resolve(message);
      } else {
        call.reject(new Error(message.error ?? "windows worker request failed"));
      }
    }
  }

  private onWorkerGone(child: ChildProcess, reason: string): void {
    if (this.worker !== child) {
      return;
    }
    this.worker = undefined;
    this.buffer = "";
    const error = new WindowsWorkerDeadError(reason);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  private request(
    child: ChildProcess,
    payload: Record<string, unknown>,
    timeoutMs: number,
    opLabel: string,
  ): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new WindowsWorkerDeadError(`windows worker RPC timed out (op=${opLabel})`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Run one sandboxed command inside the worker's Job Object (buffered). */
  async exec(params: WindowsExecParams): Promise<WindowsExecResult> {
    const child = await this.ensureWorker();
    const payload: Record<string, unknown> = {
      op: "exec",
      argv: params.argv,
      env: params.env,
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
    };
    if (params.stdin !== undefined) {
      const buf = typeof params.stdin === "string" ? Buffer.from(params.stdin) : params.stdin;
      payload.stdin = buf.toString("base64");
    }
    // RPC deadline headroom over the command's own timeout so a command that runs
    // to its limit reports a real result instead of an RPC timeout racing it.
    const response = await this.request(child, payload, params.timeoutMs + 10_000, "exec");
    return {
      code: typeof response.code === "number" ? response.code : 1,
      stdout: Buffer.from(typeof response.stdout === "string" ? response.stdout : "", "base64"),
      stderr: Buffer.from(typeof response.stderr === "string" ? response.stderr : "", "base64"),
      timedOut: response.timedOut === true,
    };
  }

  /** Health probe over the worker RPC channel. */
  async ping(): Promise<{ pid: number }> {
    const child = await this.ensureWorker();
    const response = await this.request(child, { op: "ping" }, 10_000, "ping");
    return { pid: typeof response.pid === "number" ? response.pid : -1 };
  }

  /**
   * Spawn a long-lived sandboxed helper (the fs-bridge pin owner) directly, with
   * its stdio as a streaming RPC channel. The reaper tracks its pid so scope
   * teardown force-kills the tree; srt-win's own kill-on-close job reaps the
   * runner+child if the broker dies.
   */
  spawnPersistent(params: {
    argv: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
  }): PersistentChildHandle {
    if (this.disposed) {
      throw new WindowsWorkerDeadError("windows scope reaper has been disposed");
    }
    const [command, ...rest] = params.argv;
    if (!command) {
      throw new Error("srt-sandbox produced an empty windows pin-owner command.");
    }
    const child = spawn(command, rest, {
      env: params.env,
      cwd: params.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    const pid = child.pid;
    if (pid !== undefined) {
      this.tracked.add(pid);
    }
    const forget = () => {
      if (pid !== undefined) {
        this.tracked.delete(pid);
      }
    };
    child.on("exit", () => {
      killTree(pid);
      forget();
    });
    child.on("error", forget);
    if (!child.stdin || !child.stdout) {
      killTree(pid);
      forget();
      throw new Error("srt-sandbox windows pin owner is missing its stdio channels.");
    }
    return { child, stdin: child.stdin, stdout: child.stdout };
  }

  /** Tear the scope down: shut the worker (job reaps command trees) + kill brokers. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const worker = this.worker;
    if (worker) {
      try {
        worker.stdin?.write(`${JSON.stringify({ op: "shutdown", id: this.nextId++ })}\n`);
      } catch {
        // taskkill below covers it regardless.
      }
      this.onWorkerGone(worker, "windows scope reaper disposed");
      killTree(worker.pid);
    }
    for (const pid of this.tracked) {
      killTree(pid);
    }
    this.tracked.clear();
  }
}
