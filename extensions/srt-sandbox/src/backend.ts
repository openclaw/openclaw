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
// Out of S1 scope (later stages): the pinned-mutation fs bridge / AC4 live
// handles (S3), a worker-per-scope reaper (S2), and Linux/Windows backends.
// The fs-bridge factory is intentionally not provided here.
import { spawn } from "node:child_process";
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
import { buildSrtRuntimeConfig, type SrtScopePolicyInput } from "./srt-runtime-config.js";

/** Public backend id used with registerSandboxBackend() and agents.defaults.sandbox.backend. */
export const SRT_SANDBOX_BACKEND_ID = "srt";

type SrtBackendDependencies = {
  pluginConfig: ResolvedSrtPluginConfig;
};

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

  constructor(
    private readonly params: CreateSandboxBackendParams,
    private readonly deps: SrtBackendDependencies,
  ) {
    this.runtimeConfig = buildSrtRuntimeConfig(scopePolicyFromParams(params), deps.pluginConfig);
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
    const result = await this.spawnBuffered(argv, env, params);
    if (!params.allowFailure && result.code !== 0) {
      throw new Error(
        `srt-sandbox command failed (exit ${result.code}): ${result.stderr.toString("utf8").trim()}`,
      );
    }
    return result;
  }

  private spawnBuffered(
    argv: string[],
    env: NodeJS.ProcessEnv,
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    const [command, ...commandArgs] = argv;
    if (!command) {
      return Promise.reject(new Error("srt-sandbox produced an empty sandbox command."));
    }
    return new Promise<SandboxBackendCommandResult>((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        cwd: this.params.workspaceDir,
        env,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timeoutMs = this.deps.pluginConfig.commandTimeoutMs;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      const onAbort = () => child.kill("SIGKILL");
      params.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        params.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (err) => finish(() => reject(err)));
      child.on("close", (code) =>
        finish(() =>
          resolve({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            code: code ?? 1,
          }),
        ),
      );
      if (params.stdin !== undefined) {
        child.stdin?.end(params.stdin);
      } else {
        child.stdin?.end();
      }
    });
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
    return new SrtSandboxBackend(params, deps).asHandle();
  };
}

/**
 * Lifecycle manager. The local SRT backend owns no external runtime (no
 * container/host to reconcile), so a scope is reported running and removal is a
 * no-op — there is nothing to tear down beyond the process itself.
 */
export function createSrtSandboxBackendManager(): SandboxBackendManager {
  return {
    describeRuntime: async () => ({ running: true, configLabelMatch: true }),
    removeRuntime: async () => {},
  };
}

/** Resolve the scope workdir without starting the backend. */
export function resolveSrtSandboxWorkdir(params: CreateSandboxBackendParams): string {
  return params.workspaceDir;
}
