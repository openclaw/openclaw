import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildRemoteCommand,
  buildValidatedExecRemoteCommand,
  createRemoteShellSandboxSession,
  resolveReadOnlyWorkspaceSkillMounts,
  sanitizeEnvVars,
  type CreateSandboxBackendParams,
  type OpenClawConfig,
  type RemoteShellCommandSpec,
  type SandboxBackendCommandParams,
  type SandboxBackendCommandResult,
  type SandboxBackendFactory,
  type SandboxBackendHandle,
  type SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import {
  buildSmolMachineArgv,
  describeSmolMachine,
  formatSmolCliFailure,
  runSmolCli,
  smolCommandEnv,
  smolImageReferencesMatch,
  type SmolCliContext,
  type SmolCommandRunner,
} from "./cli.js";
import { resolveSmolPluginConfig, type ResolvedSmolPluginConfig } from "./config.js";
import { ensureSmolMachine, type SmolMount } from "./lifecycle.js";

export type CreateSmolSandboxBackendParams = {
  pluginConfig: ResolvedSmolPluginConfig;
  /** Test seam; production uses the real CLI. */
  run?: SmolCommandRunner;
};

/** Same guest path the Docker backend uses for the shared agent workspace. */
const SMOL_AGENT_WORKSPACE_MOUNT = "/agent";
const SMOL_MACHINE_NAME_PREFIX = "openclaw-smol-";

export function createSmolSandboxBackendFactory(
  params: CreateSmolSandboxBackendParams,
): SandboxBackendFactory {
  return async (createParams) => {
    if ((createParams.cfg.docker.binds?.length ?? 0) > 0) {
      throw new Error(
        "smol sandbox backend does not support sandbox.docker.binds; mount extra directories into the agent workspace instead.",
      );
    }
    const context: SmolCliContext = { config: params.pluginConfig, run: params.run };
    const machineName = resolveSmolMachineName(createParams);
    return new SmolSandboxBackendImpl({
      context,
      createParams,
      machineName,
      workdir: resolveSmolSandboxWorkdir(params.pluginConfig, createParams),
    }).asHandle();
  };
}

export function createSmolSandboxBackendManager(
  params: CreateSmolSandboxBackendParams,
): SandboxBackendManager {
  const contextFor = (config: OpenClawConfig): SmolCliContext => ({
    config: resolveSmolPluginConfigFromConfig(config, params.pluginConfig),
    run: params.run,
  });
  return {
    async describeRuntime({ entry, config }) {
      const context = contextFor(config);
      const machine = await describeSmolMachine(context, entry.containerName);
      const actualConfigLabel = machine?.image ?? entry.image;
      return {
        running: machine?.state === "running",
        actualConfigLabel,
        configLabelMatch: smolImageReferencesMatch(actualConfigLabel, context.config.image),
      };
    },
    async removeRuntime({ entry, config }) {
      const context = contextFor(config);
      // A machine the operator already deleted is a completed removal, not an error.
      if (!(await describeSmolMachine(context, entry.containerName))) {
        return;
      }
      const result = await runSmolCli(
        context,
        buildSmolMachineArgv(context.config, "rm", entry.containerName, ["--force", "--local"]),
      );
      if (result.code !== 0) {
        throw new Error(formatSmolCliFailure("machine rm", result));
      }
    },
  };
}

/** The plugin's workdir wins; otherwise the sandbox keeps its Docker-shaped workdir. */
export function resolveSmolSandboxWorkdir(
  pluginConfig: ResolvedSmolPluginConfig,
  params: Pick<CreateSandboxBackendParams, "cfg">,
): string {
  return pluginConfig.workdir ?? params.cfg.docker.workdir;
}

/**
 * One machine per sandbox scope. The registry hands back the IDs it already
 * knows for this scope; keeping the same deterministic name means a Gateway
 * restart adopts the existing machine instead of creating a second one.
 */
export function resolveSmolMachineName(
  params: Pick<CreateSandboxBackendParams, "scopeKey" | "registeredRuntimeIds">,
): string {
  const scopeKey = params.scopeKey.trim() || "session";
  const name = `${SMOL_MACHINE_NAME_PREFIX}${createHash("sha256").update(scopeKey).digest("hex").slice(0, 16)}`;
  return params.registeredRuntimeIds?.find((id) => id === name) ?? name;
}

/** Host directories the machine mounts, in the order the Docker backend projects them. */
export function resolveSmolMounts(
  params: Pick<
    CreateSandboxBackendParams,
    "workspaceDir" | "agentWorkspaceDir" | "skillsWorkspaceDir" | "readOnlyResourceMounts" | "cfg"
  >,
  workdir: string,
): SmolMount[] {
  const access = params.cfg.workspaceAccess;
  const mounts = new Map<string, SmolMount>();
  const add = (mount: SmolMount) => mounts.set(normalizeGuestPath(mount.guestPath), mount);
  add({ hostPath: params.workspaceDir, guestPath: workdir, readOnly: access === "ro" });
  if (
    access !== "none" &&
    path.resolve(params.agentWorkspaceDir) !== path.resolve(params.workspaceDir)
  ) {
    add({
      hostPath: params.agentWorkspaceDir,
      guestPath: SMOL_AGENT_WORKSPACE_MOUNT,
      readOnly: access === "ro",
    });
  }
  const skillMounts = resolveReadOnlyWorkspaceSkillMounts({
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir,
    workspaceAccess: access,
  });
  for (const mount of [...skillMounts, ...(params.readOnlyResourceMounts ?? [])]) {
    add({ hostPath: mount.hostPath, guestPath: mount.containerPath, readOnly: true });
  }
  return [...mounts.values()];
}

/** `smol machine exec` argv that runs one guest shell command. */
export function buildSmolExecArgv(params: {
  config: ResolvedSmolPluginConfig;
  machineName: string;
  remoteCommand: string;
  tty?: boolean;
}): string[] {
  const argv = buildSmolMachineArgv(params.config, "exec", params.machineName, ["--local", "-i"]);
  if (params.tty) {
    argv.push("-t");
  }
  argv.push("--", "/bin/sh", "-c", params.remoteCommand);
  return argv;
}

class SmolSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;
  private readonly pendingExecs = new WeakMap<object, () => Promise<void>>();

  constructor(
    private readonly params: {
      context: SmolCliContext;
      createParams: CreateSandboxBackendParams;
      machineName: string;
      workdir: string;
    },
  ) {}

  asHandle(): SandboxBackendHandle {
    const { createParams, machineName, workdir } = this.params;
    return {
      id: "smol",
      runtimeId: machineName,
      runtimeLabel: machineName,
      workdir,
      env: createParams.cfg.docker.env,
      configLabel: this.params.context.config.image,
      configLabelKind: "Image",
      capabilities: { readOnlyResourceMounts: true },
      buildExecSpec: async ({ command, workdir: requestedWorkdir, env, usePty }) => {
        // Validation sees the model's own text; env is staged by the session, so
        // PATH additions export directly without a login-profile reset.
        const remoteCommand = buildValidatedExecRemoteCommand({
          command,
          workdir: requestedWorkdir ?? workdir,
          env: {},
        });
        await this.ensureMachine();
        createParams.assertRuntimeCurrent?.();
        const prepared = await this.session().prepareExec({ remoteCommand, env, tty: usePty });
        try {
          createParams.assertRuntimeCurrent?.();
        } catch (error) {
          await prepared.cleanup();
          throw error;
        }
        const finalizeToken = {};
        this.pendingExecs.set(finalizeToken, prepared.cleanup);
        return {
          argv: prepared.argv,
          env: prepared.env,
          stdinMode: usePty ? "pipe-open" : "pipe-closed",
          assertCurrent: createParams.assertRuntimeCurrent,
          finalizeToken,
        };
      },
      finalizeExec: async ({ token }) => {
        if (!token || typeof token !== "object") {
          return;
        }
        const cleanup = this.pendingExecs.get(token);
        if (!cleanup) {
          return;
        }
        this.pendingExecs.delete(token);
        await cleanup();
      },
      runShellCommand: (command) => this.runShellCommand(command),
    };
  }

  private session() {
    const { context, machineName, createParams } = this.params;
    return createRemoteShellSandboxSession({
      buildCommand: ({ remoteCommand, tty }): RemoteShellCommandSpec => ({
        argv: buildSmolExecArgv({ config: context.config, machineName, remoteCommand, tty }),
        env: smolCommandEnv(sanitizeEnvVars(process.env).allowed),
      }),
      assertCurrent: createParams.assertRuntimeCurrent,
      formatFailure: (stderr, exitCode) =>
        stderr.trim() || `smol machine exec exited with code ${exitCode}`,
    });
  }

  private async runShellCommand(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    params.signal?.throwIfAborted();
    await this.ensureMachine();
    params.signal?.throwIfAborted();
    return await this.session().runCommand({
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        params.script,
        "openclaw-sandbox-fs",
        ...(params.args ?? []),
      ]),
      stdin: params.stdin,
      allowFailure: params.allowFailure,
      signal: params.signal,
    });
  }

  private async ensureMachine(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    // Concurrent tool calls share one bring-up; a failure resets it so the
    // next call retries instead of replaying a rejected promise forever.
    this.ensurePromise = this.ensureMachineInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureMachineInner(): Promise<void> {
    const { context, createParams, machineName, workdir } = this.params;
    await ensureSmolMachine({
      context,
      machineName,
      scopeKey: createParams.scopeKey,
      network: createParams.cfg.docker.network !== "none",
      mounts: resolveSmolMounts(createParams, workdir),
      assertCurrent: createParams.assertRuntimeCurrent,
    });
  }
}

function normalizeGuestPath(guestPath: string): string {
  const normalized = path.posix.normalize(guestPath.replace(/\\/g, "/"));
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function resolveSmolPluginConfigFromConfig(
  config: OpenClawConfig,
  fallback: ResolvedSmolPluginConfig,
): ResolvedSmolPluginConfig {
  const pluginConfig = config.plugins?.entries?.smol?.config;
  return pluginConfig ? resolveSmolPluginConfig(pluginConfig) : fallback;
}
