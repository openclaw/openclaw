/**
 * Bounds ACP session startup. The embedded acpx runtime awaits the peer's `initialize`
 * answer without a deadline, so a command that is not an ACP server (for example
 * `codex exec`, which waits for a prompt on stdin) would park one idle child per spawn.
 * On expiry this stops the processes spawned for that session; their exit makes acpx's own
 * initialize-failure path run its teardown, and the spawn fails with a typed error.
 */
import type { AcpProcessExit, AcpProcessStarted } from "acpx/runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { AcpRuntimeError } from "../runtime-api.js";
import { renderAgentCommand, type AcpxAgentCommand } from "./command-line.js";

const ACPX_HANDSHAKE_TIMEOUT_DETAIL_CODE = "ACP_HANDSHAKE_TIMEOUT";
const DEFAULT_KILL_GRACE_MS = 2_000;

export type AcpxStartupDeadlineDeps = {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  killGraceMs?: number;
};

export class AcpxStartupDeadline {
  // launchId -> live runtime-session process; removed when acpx reports its exit.
  private readonly processes = new Map<string, { pid: number; sessionKey: string }>();
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly killGraceMs: number;

  constructor(deps: AcpxStartupDeadlineDeps = {}) {
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  noteSpawned(started: AcpProcessStarted): void {
    if (started.scope.kind === "runtime-session") {
      this.processes.set(started.launchId, {
        pid: started.pid,
        sessionKey: started.scope.sessionKey,
      });
    }
  }

  noteExited(exit: AcpProcessExit): void {
    this.processes.delete(exit.launchId);
  }

  async run<T>(params: {
    sessionKey: string;
    agent: string;
    command: AcpxAgentCommand | undefined;
    timeoutMs: number;
    run: () => Promise<T>;
    /** Releases a session whose startup finished only after the deadline stopped its process. */
    releaseLate: (value: T) => Promise<void>;
  }): Promise<T> {
    const preexisting = new Set(this.processes.keys());
    const startup = params.run();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), params.timeoutMs);
      timer.unref?.();
    });
    let first: "settled" | "expired";
    try {
      first = await Promise.race([startup.then(() => "settled" as const), expired]);
    } finally {
      clearTimeout(timer);
    }
    if (first === "settled") {
      return await startup;
    }
    const launches = [...this.processes].filter(
      ([launchId, entry]) => !preexisting.has(launchId) && entry.sessionKey === params.sessionKey,
    );
    if (launches.length === 0) {
      // Nothing of ours is waiting on a handshake (for example a queued admission); the
      // owning operation keeps its own lifecycle.
      return await startup;
    }
    const outcome = await this.stop(launches, startup);
    // A startup that still resolves won the race with the stop signal; the caller gets the
    // timeout error, so its handle is unusable and nobody else will close it.
    if (outcome.kind === "resolved") {
      await params.releaseLate(outcome.value).catch(() => {});
    } else if (outcome.kind === "pending") {
      void startup.then(params.releaseLate, () => {}).catch(() => {});
    }
    const stopped = outcome.kind === "rejected" ? outcome.message : undefined;
    const seconds = Math.round(params.timeoutMs / 100) / 10;
    const command = params.command ? renderAgentCommand(params.command) : params.agent;
    // The message reaches tool results and chat; configured argv or stderr may carry secrets.
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      redactSensitiveText(
        `ACP agent "${params.agent}" (${command}) did not complete ACP startup within ${seconds}s and was stopped. ` +
          "Check that the configured command starts an ACP server; one-shot runners such as `codex exec` are not ACP servers." +
          (stopped ? ` Last error: ${stopped}` : ""),
      ),
      { detailCode: ACPX_HANDSHAKE_TIMEOUT_DETAIL_CODE },
    );
  }

  private async stop<T>(
    launches: Array<[string, { pid: number }]>,
    startup: Promise<T>,
  ): Promise<
    { kind: "resolved"; value: T } | { kind: "rejected"; message: string } | { kind: "pending" }
  > {
    for (const [, { pid }] of launches) {
      this.signal(pid, "SIGTERM");
    }
    const settled = startup.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({
        kind: "rejected" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const grace = (ms: number) =>
      new Promise<"grace">((resolve) => {
        setTimeout(() => resolve("grace"), ms).unref?.();
      });
    let outcome = await Promise.race([settled, grace(this.killGraceMs)]);
    if (outcome === "grace") {
      // Only escalate for launches acpx has not reported as exited, so a recycled PID is safe.
      for (const [launchId, { pid }] of launches) {
        if (this.processes.has(launchId)) {
          this.signal(pid, "SIGKILL");
        }
      }
      outcome = await Promise.race([settled, grace(this.killGraceMs)]);
    }
    return outcome === "grace" ? { kind: "pending" } : outcome;
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
