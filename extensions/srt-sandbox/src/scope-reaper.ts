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
      return Promise.reject(params.signal.reason ?? new Error("aborted"));
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
   * Tear the scope down: SIGKILL every tracked process group and refuse further
   * work. Idempotent. After this returns, no sandbox process spawned by this
   * scope survives, including background descendants.
   */
  dispose(): void {
    this.disposed = true;
    for (const child of this.live) {
      killGroup(child.pid, "SIGKILL");
      child.stdio[3]?.destroy();
    }
    // Registry entries are removed by each command's own "close"/"error" path
    // once the kill lands; nothing else to release here.
  }
}
