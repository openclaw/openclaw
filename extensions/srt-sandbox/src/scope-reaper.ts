// Worker-per-scope child reaper for the SRT sandbox backend (Stage S2).
//
// Design authority: G2 SRT sandbox backend design v8 §S2 (worker-per-scope
// lifecycle / reaper), which carries forward the v5 §4 / v4 §4 S2 deliverable
// "POSIX reaper (pgid + PR_SET_PDEATHSIG / macOS liveness-pipe launcher)".
//
// Scope of this file (macOS path only; Linux bwrap and Windows are later
// stages and untouched here):
//   1. Every sandboxed command is spawned into its own process group
//      (spawn detached => setsid => pgid === child.pid) so the *whole* tree —
//      the outer shell, sandbox-exec, and any background descendant it starts —
//      can be reaped with a single group signal, not just the direct child
//      (the S1 backend killed only the direct pid, leaking backgrounded
//      grandchildren on timeout/abort).
//   2. A per-scope registry tracks every live child; scope teardown
//      (SrtSandboxBackend.dispose via manager.removeRuntime / plugin lifecycle
//      cleanup) group-kills all of them => no orphan sandbox processes.
//   3. macOS has no PR_SET_PDEATHSIG, so a liveness pipe covers *parent death*
//      (Gateway/backend crash, where graceful teardown never runs): the outer
//      shell holds an inherited read fd whose write end lives only in this
//      process; a tiny shell watcher blocks on it and SIGKILLs its own process
//      group the instant the fd reaches EOF (parent gone). See
//      {@link wrapWithLivenessLauncher}.
//
// The launcher is injected at the *outer* (unsandboxed) shell level — the argv
// produced by SandboxManager.wrapWithSandboxArgv is
// `[binShell, "-c", "env … sandbox-exec -p '<profile>' <binShell> -c '<user>'"]`
// (@anthropic-ai/sandbox-runtime@0.0.76 src/sandbox/sandbox-manager.ts:1800) —
// so the watcher and the group signal run outside Seatbelt and the sandboxed
// inner command is left byte-for-byte unchanged (no enforcement change vs S1).
import { spawn, type ChildProcess } from "node:child_process";

/** Inherited fd the sandboxed outer shell reads to detect parent death. */
export const LIVENESS_FD = 3;

/**
 * Inherited fd the per-session broker's `srt` process reads config updates from
 * (`srt --control-fd 4`). Distinct from {@link LIVENESS_FD} so a broker can hold
 * both: the liveness watcher on fd 3, live allowlist updates on fd 4 (S4-P1).
 */
export const CONTROL_FD = 4;

/** Buffered result of a reaped sandbox command (mirrors SandboxBackendCommandResult). */
export type ReapedCommandResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

/** Inputs for a single reaped spawn. `argv` is the outer wrapper argv from
 *  wrapWithSandboxArgv: `[binShell, "-c", <outerCommand>]`. */
export type ReapedSpawnParams = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin?: Buffer | string;
  timeoutMs: number;
  signal?: AbortSignal;
};

/** Thrown when a command is submitted after the scope has been torn down. */
export class ScopeReaperDisposedError extends Error {
  constructor() {
    super("srt-sandbox scope has been torn down; no further commands accepted.");
    this.name = "ScopeReaperDisposedError";
  }
}

/** Inputs for a long-lived (persistent) reaped spawn — no buffering, no timeout. */
export type PersistentSpawnParams = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
};

/**
 * Handle for a persistent reaped child (S3 pin owner). The child stays alive
 * across many stdin/stdout exchanges; the reaper still owns its process-group
 * lifecycle so it never outlives the scope or the host process.
 */
export type PersistentChildHandle = {
  child: ChildProcess;
  /** Owner request channel (child stdin, fd 0). */
  stdin: NodeJS.WritableStream;
  /** Owner response channel (child stdout, fd 1). */
  stdout: NodeJS.ReadableStream;
};

/** Inputs for a per-session broker spawn (S4-P1). `argv` is the outer wrapper
 *  argv `[binShell, "-c", <srt invocation>]`; the launcher is injected here. */
export type BrokerSpawnParams = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
};

/**
 * Handle for a per-session broker child (S4-P1). Adds a control channel (fd 4)
 * to the persistent handle: the driver writes JSON-lines config updates there
 * so `srt --control-fd 4` re-scopes the session's allowlist live. Reaper owns
 * the process-group lifecycle exactly as for {@link PersistentChildHandle}.
 */
export type BrokerChildHandle = {
  child: ChildProcess;
  /** Executor request channel (child stdin, fd 0). */
  stdin: NodeJS.WritableStream;
  /** Executor response channel (child stdout, fd 1). */
  stdout: NodeJS.ReadableStream;
  /** Broker control channel ({@link CONTROL_FD}); JSON-lines to updateConfig(). */
  control: NodeJS.WritableStream;
};

/**
 * Wrap the outer sandbox command with the macOS liveness-pipe launcher.
 *
 * The returned script (run by the outer, detached, group-leader shell):
 *   - starts a background watcher that blocks reading {@link LIVENESS_FD} and,
 *     on EOF (this process — the write-end holder — has died), SIGKILLs the
 *     whole process group (`-$$`, which is the group leader because the outer
 *     shell was spawned detached);
 *   - runs the original command, preserving its exit status;
 *   - kills the watcher and exits with the command's status on normal
 *     completion, so no launcher machinery survives a clean run.
 *
 * The watcher closes fd 1/2 so it never holds the captured stdout/stderr pipes
 * open (otherwise buffered reads would block until the watcher exited).
 */
export function wrapWithLivenessLauncher(outerCommand: string): string {
  const watcher =
    `{ while IFS= read -r _ <&${LIVENESS_FD}; do :; done; ` +
    `kill -KILL -- "-$$" 2>/dev/null; } <&${LIVENESS_FD} 1>&- 2>&- & __srt_live=$!`;
  return [
    watcher,
    outerCommand,
    `__srt_ec=$?`,
    `kill "$__srt_live" 2>/dev/null`,
    `exit "$__srt_ec"`,
  ].join("\n");
}

/** Send `signal` to the whole process group led by `pid`; ignore already-gone. */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // ESRCH = group already gone; EPERM = nothing we can do — both are terminal.
    void err;
  }
}

/**
 * Per-scope reaper: one instance is owned by one {@link SrtSandboxBackend}
 * (i.e. one OpenClaw sandbox scope). It spawns sandboxed commands into isolated
 * process groups, tracks them, and guarantees no group outlives either the
 * command, the scope, or this process.
 */
export class ScopeChildReaper {
  private readonly live = new Set<ChildProcess>();
  private disposed = false;

  /** Number of tracked, still-running children (0 when fully drained). */
  get liveCount(): number {
    return this.live.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Run one command to completion, buffering stdout/stderr. */
  spawn(params: ReapedSpawnParams): Promise<ReapedCommandResult> {
    if (this.disposed) {
      return Promise.reject(new ScopeReaperDisposedError());
    }
    if (params.signal?.aborted) {
      const reason = params.signal.reason;
      return Promise.reject(
        reason instanceof Error ? reason : new Error("srt-sandbox command aborted."),
      );
    }
    const [command, ...rest] = params.argv;
    if (!command) {
      return Promise.reject(new Error("srt-sandbox produced an empty sandbox command."));
    }
    // Expect the macOS wrapWithSandboxArgv shape `[binShell, "-c", <command>]`
    // and inject the launcher into the final command element.
    const wrappedArgs = [...rest];
    const last = wrappedArgs.length - 1;
    if (last < 0) {
      return Promise.reject(new Error("srt-sandbox sandbox command is missing its script."));
    }
    wrappedArgs[last] = wrapWithLivenessLauncher(wrappedArgs[last]!);

    return new Promise<ReapedCommandResult>((resolve, reject) => {
      const child = spawn(command, wrappedArgs, {
        cwd: params.cwd,
        env: params.env,
        // New session/process group so the entire sandbox subtree is reapable
        // and never shares this process's group.
        detached: true,
        // fd3 is the liveness pipe: the parent (this process) holds the write
        // end (child.stdio[3]); the sandboxed outer shell reads it.
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });

      const livenessEnd = child.stdio[3];
      // Never write to the liveness pipe — it must reach EOF only when this
      // process dies. Swallow errors so a broken pipe cannot crash the host.
      livenessEnd?.on("error", () => {});

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let exitCode: number | null = null;
      let settled = false;

      const timer = setTimeout(() => {
        killGroup(child.pid, "SIGKILL");
      }, params.timeoutMs);

      const onAbort = () => killGroup(child.pid, "SIGKILL");
      params.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timer);
        params.signal?.removeEventListener("abort", onAbort);
        this.live.delete(child);
        // Release the write end so the child's read fd can never dangle.
        livenessEnd?.destroy();
      };

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

      child.on("error", (err) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      });

      // "exit" fires when the outer shell exits; sweep any background
      // descendants it left behind so their inherited stdout/stderr pipes close
      // (otherwise "close" — and this command — would hang on them) and no
      // survivor outlives the buffered command.
      child.on("exit", (code) => {
        exitCode = code;
        killGroup(child.pid, "SIGKILL");
      });

      child.on("close", () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          code: exitCode ?? 1,
        });
      });

      this.live.add(child);

      if (params.stdin !== undefined) {
        child.stdin?.end(params.stdin);
      } else {
        child.stdin?.end();
      }
    });
  }

  /**
   * Launch a long-lived sandboxed helper (the S3 pin owner) into its own
   * process group with the liveness launcher, and track it exactly like a
   * buffered command so scope teardown / host death still group-kills it. The
   * caller drives it over the returned stdin/stdout; unlike {@link spawn} there
   * is no completion buffering and no timeout — the helper lives until it exits,
   * is shut down by the caller, or the scope is disposed.
   */
  spawnPersistent(params: PersistentSpawnParams): PersistentChildHandle {
    if (this.disposed) {
      throw new ScopeReaperDisposedError();
    }
    const [command, ...rest] = params.argv;
    if (!command) {
      throw new Error("srt-sandbox produced an empty sandbox command.");
    }
    const wrappedArgs = [...rest];
    const last = wrappedArgs.length - 1;
    if (last < 0) {
      throw new Error("srt-sandbox sandbox command is missing its script.");
    }
    wrappedArgs[last] = wrapWithLivenessLauncher(wrappedArgs[last]!);

    const child = spawn(command, wrappedArgs, {
      cwd: params.cwd,
      env: params.env,
      // Own session/process group so the whole helper subtree is reapable.
      detached: true,
      // fd3 is the liveness pipe (write end held only here); fd0/fd1 carry the
      // request/response RPC, fd2 the helper's diagnostics.
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });

    const livenessEnd = child.stdio[3];
    livenessEnd?.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});

    const forget = () => {
      this.live.delete(child);
      livenessEnd?.destroy();
    };
    // Sweep any descendant the helper spawned and drop it from the registry the
    // instant it exits, so no survivor lingers and dispose() has nothing stale.
    child.on("exit", () => {
      killGroup(child.pid, "SIGKILL");
      forget();
    });
    child.on("error", forget);

    this.live.add(child);
    if (!child.stdin || !child.stdout) {
      killGroup(child.pid, "SIGKILL");
      forget();
      throw new Error("srt-sandbox pin owner is missing its stdio channels.");
    }
    return { child, stdin: child.stdin, stdout: child.stdout };
  }

  /**
   * Launch a per-session network broker (S4-P1): the same detached-group +
   * liveness-launcher lifecycle as {@link spawnPersistent}, plus a dedicated
   * control channel on {@link CONTROL_FD}. The broker is the `srt --control-fd`
   * process; fd 0/1 carry the executor RPC, fd 3 the liveness pipe, fd 4 the
   * live config-update channel. Tracked exactly like every other reaped child,
   * so scope teardown / host death group-kills the broker (and, on Linux, the
   * bwrap child + its socat bridge, which live in the broker's process group).
   */
  spawnBroker(params: BrokerSpawnParams): BrokerChildHandle {
    if (this.disposed) {
      throw new ScopeReaperDisposedError();
    }
    const [command, ...rest] = params.argv;
    if (!command) {
      throw new Error("srt-sandbox produced an empty broker command.");
    }
    const wrappedArgs = [...rest];
    const last = wrappedArgs.length - 1;
    if (last < 0) {
      throw new Error("srt-sandbox broker command is missing its script.");
    }
    wrappedArgs[last] = wrapWithLivenessLauncher(wrappedArgs[last]!);

    const child = spawn(command, wrappedArgs, {
      cwd: params.cwd,
      env: params.env,
      // Own session/process group so the whole broker subtree (srt + bwrap +
      // socat on Linux) is reapable with one group signal.
      detached: true,
      // 0/1: executor RPC; 2: srt + executor diagnostics; 3: liveness pipe
      // (write end held only here); 4: control-fd config-update channel.
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });

    const livenessEnd = child.stdio[LIVENESS_FD];
    const controlEnd = child.stdio[CONTROL_FD];
    livenessEnd?.on("error", () => {});
    controlEnd?.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});

    const forget = () => {
      this.live.delete(child);
      livenessEnd?.destroy();
      controlEnd?.destroy();
    };
    child.on("exit", () => {
      killGroup(child.pid, "SIGKILL");
      forget();
    });
    child.on("error", forget);

    this.live.add(child);
    if (!child.stdin || !child.stdout || !controlEnd || typeof controlEnd === "number") {
      killGroup(child.pid, "SIGKILL");
      forget();
      throw new Error("srt-sandbox broker is missing its stdio/control channels.");
    }
    return {
      child,
      stdin: child.stdin,
      stdout: child.stdout,
      control: controlEnd as NodeJS.WritableStream,
    };
  }

  /**
   * Tear the scope down: SIGKILL every tracked process group and refuse further
   * work. Idempotent. After this returns, no sandbox process spawned by this
   * scope survives, including background descendants.
   */
  dispose(): void {
    this.disposed = true;
    for (const child of this.live) {
      killGroup(child.pid, "SIGKILL");
      child.stdio[LIVENESS_FD]?.destroy();
      // Brokers (S4-P1) also hold a control pipe on CONTROL_FD; other children
      // spawn with a 4-element stdio array so this index is simply undefined.
      child.stdio[CONTROL_FD]?.destroy();
    }
    // Registry entries are removed by each command's own "close"/"error" path
    // once the kill lands; nothing else to release here.
  }
}
