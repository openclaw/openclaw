import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// Per-session network broker (Stage S4-P1, XIN-1936 — Candidate 2).
//
// Implements the S4 spike verdict (XIN-1932): one `srt --control-fd` broker
// process per session. Each broker is an independent `srt` CLI process, so it
// runs its own SandboxManager.initialize() and therefore owns a PRIVATE proxy
// + auth token + allowlist + (Linux) network namespace. That per-process
// separation is the only real fix for R3 — inside a single manager process the
// network layer is module-level singletons bound once at initialize()
// (sandbox-manager.ts:126,129,147,908-911), so two scopes sharing one manager
// share one network policy.
//
// This class owns a broker's whole lifecycle:
//   - spawn: write a per-broker settings file, launch `srt --settings <f>
//     --control-fd 4 -c <executor>` through the S2 reaper (detached group +
//     liveness launcher), and health-check the `ready` handshake. A spawn that
//     never reaches the sandboxed executor fails CLOSED — exec rejects, and the
//     session never runs unsandboxed or through another session's broker.
//   - exec: newline-delimited JSON RPC over the broker's stdin/stdout. The
//     executor runs each command INSIDE the broker's sandbox, so the command's
//     traffic inherits the broker's proxy env + netns — the session's own
//     network scope, not a shared one.
//   - re-scope: write a full config JSON-line to the control fd; SRT's
//     updateConfig() swaps the singleton config live (sandbox-manager.ts:
//     1956-1986), so allowlist changes take effect for subsequent requests with
//     no broker restart. parentProxy is captured by value at proxy creation and
//     is NOT hot-swappable (:1979-1982), so a parentProxy change fails closed
//     with a clear error demanding a re-init rather than silently no-op'ing.
//   - death: every in-flight call fails closed; a later exec lazily respawns a
//     fresh (still sandboxed, same-policy) broker — a crash never wedges the
//     session and never drops it out of the sandbox.
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { shellEscape } from "openclaw/plugin-sdk/sandbox";
import {
  buildBrokerRuntimeConfig,
  sameParentProxy,
  serializeBrokerConfig,
  type BrokerNetworkPolicy,
  type BrokerParentProxy,
} from "./broker-config.js";
import { buildBrokerExecutorCommand } from "./broker-executor.js";
import { CONTROL_FD, type BrokerChildHandle, type ScopeChildReaper } from "./scope-reaper.js";

/** Spawn / health-check failed; the session has no network and no unsandboxed fallback. */
export class SessionBrokerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBrokerUnavailableError";
  }
}

/** The broker process is gone (exited / EOF / disposed); the call failed closed. */
export class SessionBrokerDeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBrokerDeadError";
  }
}

/** A live parentProxy change was requested; it is not hot-swappable, so refuse. */
export class SessionBrokerParentProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBrokerParentProxyError";
  }
}

/** Result of one command executed inside the broker's sandbox. */
export type BrokerExecResult = {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
};

export type BrokerExecParams = {
  script: string;
  stdin?: Buffer | string;
  timeoutMs?: number;
  shell?: string;
};

export type SessionBrokerDeps = {
  /** The scope's reaper — owns the broker's process-group lifecycle (S2). */
  reaper: ScopeChildReaper;
  /** Writable roots for the broker's filesystem allowlist. */
  writableRoots: string[];
  /** Initial per-session network policy. */
  policy: BrokerNetworkPolicy;
  /** Working directory for the broker process. */
  cwd: string;
  /** POSIX shell used for the outer wrapper. */
  binShell: string;
  /** Per-request RPC timeout (ms); a wedged broker fails the call closed. */
  rpcTimeoutMs: number;
  /** Startup handshake timeout (ms) — spawn fails closed if no `ready`. */
  readyTimeoutMs?: number;
  /** Override the `srt` CLI path (tests); defaults to the resolved package bin. */
  srtCliPath?: string;
  /** Override the node executable (tests); defaults to process.execPath. */
  nodePath?: string;
};

type BrokerResponse = {
  id?: unknown;
  ok?: boolean;
  error?: string;
  code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  timedOut?: unknown;
} & Record<string, unknown>;

type PendingCall = {
  resolve: (value: BrokerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const require = createRequire(import.meta.url);

/** Resolve the vendored `srt` CLI (dist/cli.js) from the pinned SRT package. */
function resolveSrtCliPath(): string {
  const pkgMain = require.resolve("@anthropic-ai/sandbox-runtime");
  return path.join(path.dirname(pkgMain), "cli.js");
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;

export class SessionBroker {
  private proc: BrokerChildHandle | undefined;
  private spawning: Promise<BrokerChildHandle> | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private buffer = "";
  private disposed = false;
  /** Ready-handshake latch for the currently-attached broker. */
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private settingsPath: string | undefined;
  private settingsDir: string | undefined;
  private allowedDomains: string[];
  private readonly parentProxy: BrokerParentProxy | undefined;
  private readonly srtCliPath: string;
  private readonly nodePath: string;
  private readonly readyTimeoutMs: number;

  constructor(private readonly deps: SessionBrokerDeps) {
    this.allowedDomains = [...deps.policy.allowedDomains];
    this.parentProxy = deps.policy.parentProxy;
    this.srtCliPath = deps.srtCliPath ?? resolveSrtCliPath();
    this.nodePath = deps.nodePath ?? process.execPath;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  /** True while a live broker process is attached (test/introspection aid). */
  get isRunning(): boolean {
    return this.proc !== undefined;
  }

  /** The allowlist the broker currently enforces (post any live re-scope). */
  get currentAllowedDomains(): string[] {
    return [...this.allowedDomains];
  }

  /** Broker OS pid, or undefined when no broker is attached. */
  get pid(): number | undefined {
    return this.proc?.child.pid;
  }

  private buildRuntimeConfigJson(): string {
    return serializeBrokerConfig(
      buildBrokerRuntimeConfig({
        writableRoots: this.deps.writableRoots,
        policy: { allowedDomains: this.allowedDomains, parentProxy: this.parentProxy },
      }),
    );
  }

  private buildOuterCommand(settingsPath: string): string {
    const executor = buildBrokerExecutorCommand();
    // `node cli.js --settings <f> --control-fd 4 -c <executor>`, spawned by the
    // outer group-leader shell (the reaper injects the liveness launcher). Not
    // `exec`'d, so the launcher can reap its watcher after the broker exits.
    return [
      shellEscape(this.nodePath),
      shellEscape(this.srtCliPath),
      "--settings",
      shellEscape(settingsPath),
      "--control-fd",
      String(CONTROL_FD),
      "-c",
      shellEscape(executor),
    ].join(" ");
  }

  private brokerEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The broker's own proxy is authoritative. Unless a parentProxy is
    // explicitly configured, strip inherited proxy vars so SRT does not adopt
    // an ambient HTTP_PROXY as an upstream (resolveParentProxy env fallback).
    if (!this.parentProxy) {
      delete env.HTTP_PROXY;
      delete env.http_proxy;
      delete env.HTTPS_PROXY;
      delete env.https_proxy;
      delete env.ALL_PROXY;
      delete env.all_proxy;
    }
    return env;
  }

  private async ensureBroker(): Promise<BrokerChildHandle> {
    if (this.disposed) {
      throw new SessionBrokerDeadError("session broker has been disposed");
    }
    if (this.proc) {
      return this.proc;
    }
    if (!this.spawning) {
      this.spawning = this.spawnBroker().finally(() => {
        this.spawning = undefined;
      });
    }
    return this.spawning;
  }

  private async spawnBroker(): Promise<BrokerChildHandle> {
    const dir = mkdtempSync(path.join(tmpdir(), "srt-broker-"));
    const settingsPath = path.join(dir, "settings.json");
    writeFileSync(settingsPath, this.buildRuntimeConfigJson(), { mode: 0o600 });
    this.settingsDir = dir;
    this.settingsPath = settingsPath;

    let proc: BrokerChildHandle;
    try {
      proc = this.deps.reaper.spawnBroker({
        argv: [this.deps.binShell, "-c", this.buildOuterCommand(settingsPath)],
        env: this.brokerEnv(),
        cwd: this.deps.cwd,
      });
    } catch (error) {
      this.cleanupSettings();
      throw new SessionBrokerUnavailableError(
        `failed to spawn srt broker: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.attachBroker(proc);
    try {
      await this.waitForReady(proc);
    } catch (error) {
      // Ready never arrived — the srt process failed before the sandboxed
      // executor started. Fail closed: no broker, no unsandboxed fallback.
      this.onBrokerGone(proc, "broker failed its startup health-check");
      throw error instanceof SessionBrokerUnavailableError
        ? error
        : new SessionBrokerUnavailableError(error instanceof Error ? error.message : String(error));
    }
    return proc;
  }

  private attachBroker(proc: BrokerChildHandle): void {
    this.proc = proc;
    this.buffer = "";
    proc.stdout.on("data", (chunk: Buffer | string) => {
      this.onStdout(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    proc.stdout.on("error", () => {});
    proc.stdin.on("error", () => {});
    proc.control.on("error", () => {});
    proc.child.on("exit", (code, signal) => {
      this.onBrokerGone(proc, `srt broker exited (code=${String(code)}, signal=${String(signal)})`);
    });
    proc.child.on("error", (error: Error) => {
      this.onBrokerGone(proc, `srt broker failed to launch: ${error.message}`);
    });
  }

  private waitForReady(proc: BrokerChildHandle): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyResolve = undefined;
        this.readyReject = undefined;
        reject(
          new SessionBrokerUnavailableError(
            `srt broker did not report ready within ${this.readyTimeoutMs}ms`,
          ),
        );
      }, this.readyTimeoutMs);
      this.readyResolve = () => {
        clearTimeout(timer);
        this.readyResolve = undefined;
        this.readyReject = undefined;
        resolve();
      };
      this.readyReject = (error: Error) => {
        clearTimeout(timer);
        this.readyResolve = undefined;
        this.readyReject = undefined;
        reject(error);
      };
      void proc;
    });
  }

  private onStdout(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      let message: BrokerResponse;
      try {
        message = JSON.parse(trimmed) as BrokerResponse;
      } catch {
        // Non-JSON output is broker/executor diagnostics on the wrong stream;
        // ignore it rather than tearing down healthy in-flight calls.
        continue;
      }
      // The one-time startup handshake carries no id.
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
        call.reject(new Error(message.error ?? "srt broker request failed"));
      }
    }
  }

  private onBrokerGone(proc: BrokerChildHandle, reason: string): void {
    if (this.proc !== proc) {
      return;
    }
    this.proc = undefined;
    this.buffer = "";
    this.cleanupSettings();
    const readyReject = this.readyReject;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    readyReject?.(new SessionBrokerUnavailableError(reason));
    const error = new SessionBrokerDeadError(reason);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  private cleanupSettings(): void {
    if (this.settingsDir) {
      try {
        rmSync(this.settingsDir, { recursive: true, force: true });
      } catch {
        // Best-effort; a leaked temp settings file is not a correctness issue.
      }
      this.settingsDir = undefined;
      this.settingsPath = undefined;
    }
  }

  private request(
    proc: BrokerChildHandle,
    payload: Record<string, unknown>,
    timeoutMs: number,
    opLabel: string,
  ): Promise<BrokerResponse> {
    const id = this.nextRequestId++;
    return new Promise<BrokerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new SessionBrokerDeadError(`srt broker RPC timed out (op=${opLabel})`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Run one command inside the broker's sandbox and network scope. */
  async exec(params: BrokerExecParams): Promise<BrokerExecResult> {
    const proc = await this.ensureBroker();
    const timeoutMs = params.timeoutMs ?? this.deps.rpcTimeoutMs;
    const payload: Record<string, unknown> = { op: "exec", script: params.script };
    if (params.timeoutMs !== undefined) {
      payload.timeoutMs = params.timeoutMs;
    }
    if (params.shell !== undefined) {
      payload.shell = params.shell;
    }
    if (params.stdin !== undefined) {
      const buf = typeof params.stdin === "string" ? Buffer.from(params.stdin) : params.stdin;
      payload.stdin = buf.toString("base64");
    }
    // Give the RPC deadline headroom over the command's own timeout so a
    // command that runs to its limit reports a real result instead of an
    // RPC timeout racing it.
    const rpcTimeout = params.timeoutMs !== undefined ? timeoutMs + 5_000 : this.deps.rpcTimeoutMs;
    const response = await this.request(proc, payload, rpcTimeout, "exec");
    return {
      code: typeof response.code === "number" ? response.code : 1,
      stdout: Buffer.from(typeof response.stdout === "string" ? response.stdout : "", "base64"),
      stderr: Buffer.from(typeof response.stderr === "string" ? response.stderr : "", "base64"),
      timedOut: response.timedOut === true,
    };
  }

  /** Health probe over the RPC channel. Returns the broker pid + exec count. */
  async ping(): Promise<{ pid: number; executed: number }> {
    const proc = await this.ensureBroker();
    const response = await this.request(proc, { op: "ping" }, this.deps.rpcTimeoutMs, "ping");
    return {
      pid: typeof response.pid === "number" ? response.pid : -1,
      executed: typeof response.executed === "number" ? response.executed : -1,
    };
  }

  /**
   * Re-scope the session's allowlist LIVE via the control fd — no broker
   * restart. A parentProxy change is refused (not hot-swappable): the caller
   * must recreate the broker instead of getting a silent no-op.
   */
  async setPolicy(policy: BrokerNetworkPolicy): Promise<void> {
    if (!sameParentProxy(policy.parentProxy, this.parentProxy)) {
      throw new SessionBrokerParentProxyError(
        "srt broker parentProxy is captured by value at proxy creation and is not " +
          "hot-swappable via the control fd; recreate the broker to change the upstream proxy.",
      );
    }
    const proc = await this.ensureBroker();
    this.allowedDomains = [...policy.allowedDomains];
    const line = `${this.buildRuntimeConfigJson()}\n`;
    try {
      proc.control.write(line);
    } catch (error) {
      throw new SessionBrokerDeadError(
        `failed to write control-fd config update: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Convenience: live re-scope of just the allowlist (keeps the parentProxy). */
  async setAllowedDomains(domains: string[]): Promise<void> {
    await this.setPolicy({ allowedDomains: domains, parentProxy: this.parentProxy });
  }

  /** Tear down: reject in-flight calls, ask the broker to exit, drop settings. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const proc = this.proc;
    if (proc) {
      try {
        proc.stdin.write(`${JSON.stringify({ op: "shutdown", id: this.nextRequestId++ })}\n`);
      } catch {
        // The reaper's dispose() group-kills the broker regardless.
      }
      this.onBrokerGone(proc, "session broker disposed");
      try {
        proc.stdin.end();
      } catch {
        // ignore
      }
    } else {
      this.cleanupSettings();
    }
  }
}
