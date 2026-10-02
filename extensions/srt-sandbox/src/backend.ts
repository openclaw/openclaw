// SRT sandbox backend — S1 skeleton (macOS Seatbelt minimal path).
//
// Implements the OpenClaw SandboxBackendHandle contract
// (src/agents/sandbox/backend-handle.types.ts:63-101) over the Anthropic
// Sandbox Runtime. S1 delivers the exec path only: every command is wrapped
// with SandboxManager.wrapWithSandboxArgv (@anthropic-ai/sandbox-runtime@0.0.76
// src/sandbox/sandbox-manager.ts:1800) so it runs under the kernel-enforced
// Seatbelt profile with the scope's writable allowlist. Reads stay open,
// writes are confined to the scope dirs (see srt-runtime-config.ts).
//
// Stage S2 (worker-per-scope lifecycle / reaper, design v8 §S2): every
// sandboxed command is spawned detached into its own process group and tracked
// by a per-scope reaper (scope-reaper.ts); the macOS liveness-pipe launcher
// covers parent death, scope teardown group-kills every tracked child, and
// buffered commands sweep their own background descendants on completion —
// no orphan sandbox process survives any of the four teardown scenarios.
//
// Stage S3 (AC4 pinned-mutation fs bridge, design v8 §1–§3): the handle now
// exposes createFsBridge (fs-bridge.ts). The bridge's per-scope pin owner — a
// persistent helper process — is launched INSIDE the SRT sandbox via the same
// wrapWithSandboxArgv wrap, so its held directory fds and every mutation it
// performs stay kernel-enforced against the scope's allowWrite policy; it is
// tracked by the reaper like any sandbox child and reaped on scope teardown.
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type {
  CreateSandboxBackendParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { shellEscape } from "openclaw/plugin-sdk/sandbox";
import type { ResolvedSrtPluginConfig } from "./config.js";
import { assertSrtSandboxAvailable } from "./dependency-probe.js";
import { ExecCustody } from "./exec-custody.js";
import { createSrtFsBridge } from "./fs-bridge.js";
import { PinOwnerClient } from "./pin-owner-client.js";
import { buildPinOwnerCommand } from "./pin-owner-source.js";
import { ScopeChildReaper } from "./scope-reaper.js";
import { SessionBroker } from "./session-broker.js";
import {
  buildSrtRuntimeConfig,
  resolveWritableRoots,
  type SrtScopePolicyInput,
} from "./srt-runtime-config.js";
import {
  acquireSrtRuntime,
  releaseSrtRuntime,
  shutdownSrtRuntime,
} from "./srt-runtime-lifecycle.js";
import { WindowsSrtSandboxBackend } from "./windows-backend.js";
import { resolveWindowsSrtWin } from "./windows-sandbox-config.js";

/** Public backend id used with registerSandboxBackend() and agents.defaults.sandbox.backend. */
export const SRT_SANDBOX_BACKEND_ID = "srt";

type SrtBackendDependencies = {
  pluginConfig: ResolvedSrtPluginConfig;
};

/**
 * A live per-scope backend (macOS/Linux SrtSandboxBackend or the Windows
 * WindowsSrtSandboxBackend). Both expose the scope key and a dispose() that
 * reaps the scope's sandbox processes, so teardown treats them uniformly.
 */
type DisposableScopeBackend = { readonly scopeKey: string; dispose(): void | Promise<void> };

/**
 * Live per-scope backend instances, so scope teardown (manager.removeRuntime)
 * and plugin lifecycle cleanup can reap each scope's sandbox process groups.
 * A scope may have more than one live handle across re-creations, so this is a
 * set filtered by scopeKey rather than a map.
 */
const liveScopeBackends = new Set<DisposableScopeBackend>();

/** Monotonic per-scope index (Windows account-pool / port-slot assignment). */
let windowsScopeCounter = 0;
let windowsScopeActive = false;

type PluginLifecycleState =
  | { phase: "stopped" }
  | { phase: "running"; generation: number }
  | {
      phase: "stopping";
      generation: number;
      finalizers: Set<TeardownFinalizer>;
      promise: Promise<void>;
    }
  | { phase: "faulted"; generation: number; error: unknown };

type TeardownFinalizer = () => void | Promise<void>;

let pluginLifecycleState: PluginLifecycleState = { phase: "stopped" };
let pluginLifecycleGeneration = 0;

function teardownInProgress(): Error {
  return new Error("srt-sandbox: runtime admission rejected while shutdown is in progress");
}

/** Begin one plugin registration/start cycle when teardown has fully settled. */
function startSrtSandboxRuntime(): number | undefined {
  if (pluginLifecycleState.phase === "stopped") {
    pluginLifecycleState = { phase: "running", generation: ++pluginLifecycleGeneration };
  }
  return pluginLifecycleState.phase === "running" ? pluginLifecycleState.generation : undefined;
}

function assertSrtSandboxAdmission(generation: number | undefined): number {
  if (pluginLifecycleState.phase === "faulted") {
    throw new Error("srt-sandbox: runtime cleanup failed; shutdown must succeed before retry", {
      cause: pluginLifecycleState.error,
    });
  }
  const admittedGeneration = generation ?? startSrtSandboxRuntime();
  if (
    admittedGeneration === undefined ||
    pluginLifecycleState.phase !== "running" ||
    pluginLifecycleState.generation !== admittedGeneration
  ) {
    throw teardownInProgress();
  }
  return admittedGeneration;
}

/** Dispose every live SRT scope backend (plugin disable/restart teardown). */
export async function disposeAllSrtScopeBackends(): Promise<void> {
  // Snapshot: dispose() removes the backend from the set as it runs.
  const errors: unknown[] = [];
  for (const backend of Array.from(liveScopeBackends)) {
    try {
      await backend.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "srt-sandbox: one or more scope backends failed to dispose");
  }
}

function stopSrtSandboxRuntime(finishTeardown?: TeardownFinalizer): Promise<void> {
  if (pluginLifecycleState.phase === "stopping") {
    if (finishTeardown) {
      pluginLifecycleState.finalizers.add(finishTeardown);
    }
    return pluginLifecycleState.promise;
  }
  if (pluginLifecycleState.phase === "stopped") {
    return Promise.resolve().then(finishTeardown);
  }

  const generation = pluginLifecycleState.generation;
  const stopping: Extract<PluginLifecycleState, { phase: "stopping" }> = {
    phase: "stopping",
    generation,
    finalizers: new Set(finishTeardown ? [finishTeardown] : []),
    promise: Promise.resolve(),
  };
  // Publish the stop before taking the live-backend snapshot in
  // shutdownSrtRuntime(), so every platform observes one admission authority.
  pluginLifecycleState = stopping;
  stopping.promise = (async () => {
    const errors: unknown[] = [];
    try {
      await shutdownSrtRuntime(disposeAllSrtScopeBackends);
    } catch (error) {
      errors.push(error);
    }
    while (stopping.finalizers.size > 0) {
      const finalizers = Array.from(stopping.finalizers);
      stopping.finalizers.clear();
      for (const finalize of finalizers) {
        try {
          await finalize();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "srt-sandbox: runtime and registration teardown failed");
    }
  })().then(
    () => {
      if (pluginLifecycleState === stopping) {
        pluginLifecycleState = { phase: "stopped" };
      }
    },
    (error: unknown) => {
      if (pluginLifecycleState === stopping) {
        pluginLifecycleState = { phase: "faulted", generation, error };
      }
      throw error;
    },
  );
  return stopping.promise;
}

/** Reap every scope and optionally hold admission until registration retires. */
export function shutdownSrtSandboxRuntime(
  ...args: [options?: { finishTeardown?: () => void | Promise<void> }]
): Promise<void> {
  const options = typeof args[0] === "object" ? args[0] : undefined;
  return stopSrtSandboxRuntime(options?.finishTeardown);
}

/** Dispose the live SRT scope backends for one scope (manager.removeRuntime). */
export async function disposeSrtScopeBackends(scopeKey: string): Promise<void> {
  for (const backend of Array.from(liveScopeBackends)) {
    if (backend.scopeKey === scopeKey) {
      await backend.dispose();
    }
  }
}

function scopePolicyFromParams(params: CreateSandboxBackendParams): SrtScopePolicyInput {
  return {
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workspaceAccess: params.cfg.workspaceAccess,
  };
}

/** Prepend positional args as `$1..$n` without letting them escape into the script. */
function withPositionalArgs(script: string, args: readonly string[] | undefined): string {
  if (!args || args.length === 0) {
    return script;
  }
  const set = `set -- ${args.map((arg) => shellEscape(arg)).join(" ")}`;
  return `${set}\n${script}`;
}

class SrtSandboxBackend {
  private readonly runtimeConfig: SandboxRuntimeConfig;
  /** Per-scope process-group reaper (S2). Owns every sandbox child's lifecycle. */
  private readonly reaper = new ScopeChildReaper();
  private readonly execCustody = new ExecCustody();
  /** Per-scope AC4 pin owner RPC client (S3). Lazily spawns the owner process. */
  private readonly pinOwnerClient: PinOwnerClient;
  private fsBridge: ReturnType<typeof createSrtFsBridge> | undefined;
  /**
   * Per-session network broker (S4-P1). Lazily spawned the first time a command
   * runs when perSessionNetwork is enabled; owns this session's private proxy +
   * allowlist + (Linux) netns. Left undefined on the P0 in-process path.
   */
  private sessionBroker: SessionBroker | undefined;
  private disposed = false;

  constructor(
    private readonly params: CreateSandboxBackendParams,
    private readonly deps: SrtBackendDependencies,
  ) {
    this.runtimeConfig = buildSrtRuntimeConfig(scopePolicyFromParams(params), deps.pluginConfig);
    this.pinOwnerClient = new PinOwnerClient({
      spawnOwner: () => this.spawnPinOwner(),
      rpcTimeoutMs: deps.pluginConfig.commandTimeoutMs,
    });
  }

  /** Scope this backend belongs to (used to reap by scope on teardown). */
  get scopeKey(): string {
    return this.params.scopeKey;
  }

  async initialize(): Promise<void> {
    await acquireSrtRuntime(this, this.runtimeConfig);
  }

  /** Tear down this scope: reap every tracked sandbox process group, drop the pin owner. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.execCustody.dispose();
    this.pinOwnerClient.dispose();
    this.sessionBroker?.dispose();
    this.sessionBroker = undefined;
    this.fsBridge?.dispose();
    this.fsBridge = undefined;
    this.reaper.dispose();
    liveScopeBackends.delete(this);
    await releaseSrtRuntime(this);
  }

  /**
   * Whether this scope routes commands through a per-session broker (S4-P1).
   * Only under the "deny" posture — "allow" leaves the network fully open, and
   * per-session isolation of an open network is meaningless.
   */
  private get perSessionNetworkEnabled(): boolean {
    return this.deps.pluginConfig.perSessionNetwork && this.deps.pluginConfig.network === "deny";
  }

  /** Lazily create the per-session broker for this scope (S4-P1). */
  private ensureSessionBroker(): SessionBroker {
    if (!this.sessionBroker) {
      const writableRoots = resolveWritableRoots(
        scopePolicyFromParams(this.params),
        this.deps.pluginConfig.writablePaths,
      );
      this.sessionBroker = new SessionBroker({
        reaper: this.reaper,
        writableRoots,
        policy: {
          allowedDomains: this.deps.pluginConfig.allowedDomains,
          parentProxy: this.deps.pluginConfig.parentProxy,
        },
        cwd: this.params.workspaceDir,
        binShell: this.deps.pluginConfig.binShell,
        rpcTimeoutMs: this.deps.pluginConfig.commandTimeoutMs,
      });
    }
    return this.sessionBroker;
  }

  /**
   * Launch the persistent per-scope pin owner inside the SRT sandbox (S3).
   * The same wrapWithSandboxArgv wrap as every sandboxed command means the
   * owner's held fds and mutations are kernel-enforced against the scope's
   * allowWrite policy — the held-handle model composes with SRT enforcement.
   * The reaper tracks it, so scope teardown / host death group-kills it.
   */
  private async spawnPinOwner() {
    const ownerCommand = buildPinOwnerCommand();
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      ownerCommand,
      this.deps.pluginConfig.binShell,
      this.runtimeConfig,
      undefined,
      this.params.workspaceDir,
    );
    return this.reaper.spawnPersistent({
      argv: wrapped.argv,
      env: wrapped.env ?? {},
      cwd: this.params.workspaceDir,
    });
  }

  /** Wrap a command string with the scope's Seatbelt profile. */
  private wrap(command: string, signal?: AbortSignal) {
    return SandboxManager.wrapWithSandboxArgv(
      command,
      this.deps.pluginConfig.binShell,
      this.runtimeConfig,
      signal,
      this.params.workspaceDir,
    );
  }

  private async runShellCommand(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    params.signal?.throwIfAborted();
    const script = withPositionalArgs(params.script, params.args);
    // S4-P1: per-session isolation routes the command through this scope's own
    // broker — a private srt process with its own proxy/allowlist/netns. The
    // executor runs the command INSIDE that sandbox, so its network scope is the
    // session's, not a shared one. A broker spawn/health failure fails closed
    // (throws) rather than falling back to the in-process (P0) path.
    if (this.perSessionNetworkEnabled) {
      const broker = this.ensureSessionBroker();
      const result = await broker.exec({
        script,
        stdin: params.stdin,
        timeoutMs: this.deps.pluginConfig.commandTimeoutMs,
        signal: params.signal,
      });
      if (!params.allowFailure && result.code !== 0) {
        throw new Error(
          `srt-sandbox broker command failed (exit ${result.code}): ${result.stderr.toString("utf8").trim()}`,
        );
      }
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    }
    const { argv, env } = await this.wrap(script, params.signal);
    const result = await this.reaper.spawn({
      argv,
      env,
      cwd: this.params.workspaceDir,
      stdin: params.stdin,
      timeoutMs: this.deps.pluginConfig.commandTimeoutMs,
      signal: params.signal,
    });
    if (!params.allowFailure && result.code !== 0) {
      throw new Error(
        `srt-sandbox command failed (exit ${result.code}): ${result.stderr.toString("utf8").trim()}`,
      );
    }
    return result;
  }

  asHandle(): SandboxBackendHandle {
    const runShellCommand = (params: SandboxBackendCommandParams) => this.runShellCommand(params);
    return {
      id: SRT_SANDBOX_BACKEND_ID,
      runtimeId: this.params.scopeKey,
      runtimeLabel: `srt:${this.params.scopeKey}`,
      workdir: this.params.workspaceDir,
      env: this.params.cfg.docker.env,
      configLabel: "seatbelt",
      configLabelKind: "Profile",
      // The browser sandbox is a container capability; the local SRT backend
      // does not provide it (design D: capabilities.browser=false).
      capabilities: { browser: false },
      prepareProcessCleanup: (env) => this.execCustody.prepare(env),
      buildExecSpec: async ({ command, workdir, env }) => {
        this.execCustody.assertCurrent();
        const preparedEnv = this.execCustody.ensurePreparedEnv(env);
        if (this.perSessionNetworkEnabled) {
          const prepared = this.ensureSessionBroker().prepareCommand(command, preparedEnv);
          return this.execCustody.wrap(
            {
              argv: prepared.argv,
              env: prepared.env,
              cwd: workdir ?? prepared.cwd,
              stdinMode: "pipe-open",
            },
            preparedEnv,
            prepared.cleanup,
          );
        }
        const { argv } = await this.wrap(command);
        return this.execCustody.wrap(
          {
            argv,
            // Spawn with the command's resolved environment; deny-all network
            // means no proxy env is required from the wrapper.
            env,
            cwd: workdir ?? this.params.workspaceDir,
            stdinMode: "pipe-open",
          },
          preparedEnv,
        );
      },
      finalizeExec: ({ token }) => this.execCustody.finalize(token),
      runShellCommand,
      // S3: AC4 pinned-mutation fs bridge backed by the per-scope pin owner.
      createFsBridge: ({ sandbox }) => {
        if (!this.fsBridge) {
          const writableRoots = resolveWritableRoots(
            {
              workspaceDir: sandbox.workspaceDir,
              agentWorkspaceDir: sandbox.agentWorkspaceDir,
              skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
              workspaceAccess: sandbox.workspaceAccess,
            },
            this.deps.pluginConfig.writablePaths,
          );
          this.fsBridge = createSrtFsBridge({
            sandbox,
            writableRoots,
            client: this.pinOwnerClient,
          });
        }
        return this.fsBridge;
      },
    };
  }
}

/** Create the SRT sandbox backend factory. Fails closed if the sandbox is unavailable. */
export function createSrtSandboxBackendFactory(
  deps: SrtBackendDependencies,
): SandboxBackendFactory {
  let admissionGeneration = startSrtSandboxRuntime();
  return async (params) => {
    const requestGeneration = assertSrtSandboxAdmission(admissionGeneration);
    admissionGeneration ??= requestGeneration;
    if (process.platform === "win32") {
      // S6 Windows path: low-priv account + NTFS ACL + WFP + worker-RPC per-scope
      // (windows-backend.ts). Additive; the macOS/Linux path below is untouched.
      if (windowsScopeActive) {
        throw new Error(
          "srt-sandbox: SRT 0.0.76 cannot bind concurrent scopes to distinct Windows accounts",
        );
      }
      // Reserve the one supported Windows scope before the first await so two
      // concurrent factory calls cannot both pass the admission check.
      windowsScopeActive = true;
      let backend: WindowsSrtSandboxBackend | undefined;
      try {
        const srtWin = resolveWindowsSrtWin(deps.pluginConfig.windows ?? {});
        await assertSrtSandboxAvailable(srtWin);
        assertSrtSandboxAdmission(requestGeneration);
        backend = new WindowsSrtSandboxBackend(params, deps, windowsScopeCounter++);
        const admittedBackend = backend;
        const entry: DisposableScopeBackend = {
          scopeKey: admittedBackend.scopeKey,
          dispose: () => {
            try {
              admittedBackend.dispose();
            } finally {
              windowsScopeActive = false;
              liveScopeBackends.delete(entry);
            }
          },
        };
        liveScopeBackends.add(entry);
        return admittedBackend.asHandle();
      } catch (error) {
        try {
          backend?.dispose();
        } finally {
          windowsScopeActive = false;
        }
        throw error;
      }
    }
    await assertSrtSandboxAvailable();
    assertSrtSandboxAdmission(requestGeneration);
    const backend = new SrtSandboxBackend(params, deps);
    try {
      await backend.initialize();
      assertSrtSandboxAdmission(requestGeneration);
      liveScopeBackends.add(backend);
      return backend.asHandle();
    } catch (error) {
      await backend.dispose();
      throw error;
    }
  };
}

/**
 * Lifecycle manager. The local SRT backend owns no external runtime (no
 * container/host to reconcile), so a scope is reported running and removal
 * reaps the scope's live sandbox process groups (S2 reaper) — there is nothing
 * else to tear down beyond the processes themselves.
 */
export function createSrtSandboxBackendManager(): SandboxBackendManager {
  return {
    describeRuntime: async () => ({ running: true, configLabelMatch: true }),
    removeRuntime: async ({ entry }) => {
      // entry.containerName === backend.runtimeId === scopeKey (see
      // createSandboxBackend's toEntry mapping).
      await disposeSrtScopeBackends(entry.containerName);
    },
  };
}

/** Resolve the scope workdir without starting the backend. */
export function resolveSrtSandboxWorkdir(params: CreateSandboxBackendParams): string {
  return params.workspaceDir;
}
