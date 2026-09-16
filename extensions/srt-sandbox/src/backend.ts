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
// Out of later-scope (S3+): the pinned-mutation fs bridge / AC4 live handles,
// Linux (bwrap) and Windows backends. The fs-bridge factory is intentionally
// not provided here.
//
// Stage S2 (worker-per-scope lifecycle / reaper, design v8 §S2): every
// sandboxed command is spawned detached into its own process group and tracked
// by a per-scope reaper (scope-reaper.ts); the macOS liveness-pipe launcher
// covers parent death, scope teardown group-kills every tracked child, and
// buffered commands sweep their own background descendants on completion —
// no orphan sandbox process survives any of the four teardown scenarios.
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
import { ScopeChildReaper } from "./scope-reaper.js";
import { buildSrtRuntimeConfig, type SrtScopePolicyInput } from "./srt-runtime-config.js";

/** Public backend id used with registerSandboxBackend() and agents.defaults.sandbox.backend. */
export const SRT_SANDBOX_BACKEND_ID = "srt";

type SrtBackendDependencies = {
  pluginConfig: ResolvedSrtPluginConfig;
};

/**
 * Live per-scope backend instances, so scope teardown (manager.removeRuntime)
 * and plugin lifecycle cleanup can reap each scope's sandbox process groups.
 * A scope may have more than one live handle across re-creations, so this is a
 * set filtered by scopeKey rather than a map.
 */
const liveScopeBackends = new Set<SrtSandboxBackend>();

/** Dispose every live SRT scope backend (plugin disable/restart teardown). */
export function disposeAllSrtScopeBackends(): void {
  // Snapshot: dispose() removes the backend from the set as it runs.
  for (const backend of Array.from(liveScopeBackends)) {
    backend.dispose();
  }
}

/** Dispose the live SRT scope backends for one scope (manager.removeRuntime). */
export function disposeSrtScopeBackends(scopeKey: string): void {
  for (const backend of Array.from(liveScopeBackends)) {
    if (backend.scopeKey === scopeKey) {
      backend.dispose();
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

  constructor(
    private readonly params: CreateSandboxBackendParams,
    private readonly deps: SrtBackendDependencies,
  ) {
    this.runtimeConfig = buildSrtRuntimeConfig(scopePolicyFromParams(params), deps.pluginConfig);
  }

  /** Scope this backend belongs to (used to reap by scope on teardown). */
  get scopeKey(): string {
    return this.params.scopeKey;
  }

  /** Tear down this scope: reap every tracked sandbox process group. */
  dispose(): void {
    this.reaper.dispose();
    liveScopeBackends.delete(this);
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
      buildExecSpec: async ({ command, workdir, env }) => {
        const { argv } = await this.wrap(command);
        return {
          argv,
          // Spawn with the command's resolved environment; deny-all network
          // means no proxy env is required from the wrapper.
          env,
          cwd: workdir ?? this.params.workspaceDir,
          stdinMode: "pipe-open",
        };
      },
      runShellCommand,
    };
  }
}

/** Create the SRT sandbox backend factory. Fails closed if the sandbox is unavailable. */
export function createSrtSandboxBackendFactory(
  deps: SrtBackendDependencies,
): SandboxBackendFactory {
  return async (params) => {
    await assertSrtSandboxAvailable();
    const backend = new SrtSandboxBackend(params, deps);
    liveScopeBackends.add(backend);
    return backend.asHandle();
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
      disposeSrtScopeBackends(entry.containerName);
    },
  };
}

/** Resolve the scope workdir without starting the backend. */
export function resolveSrtSandboxWorkdir(params: CreateSandboxBackendParams): string {
  return params.workspaceDir;
}
