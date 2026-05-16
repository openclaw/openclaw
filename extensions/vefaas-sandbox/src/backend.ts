import path from "node:path";
import type {
  CreateSandboxBackendParams,
  OpenClawConfig,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendManager,
  SandboxBackendHandle,
  SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import {
  buildExecRemoteCommand,
  buildRemoteCommand,
  buildSshSandboxArgv,
  createRemoteShellSandboxFsBridge,
  disposeSshSandboxSession,
  runSshSandboxCommand,
  sanitizeEnvVars,
  uploadDirectoryToSshTarget,
} from "openclaw/plugin-sdk/sandbox";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildVefaasSandboxCreateSpec,
  resolveVefaasPluginConfig,
  type ResolvedVefaasPluginConfig,
} from "./config.js";
import {
  createVefaasSshSession,
  runVefaasProvisioner,
  type VefaasProvisionerContext,
} from "./provisioner.js";

type CreateVefaasSandboxBackendFactoryParams = {
  pluginConfig: ResolvedVefaasPluginConfig;
};

type PendingExec = {
  sshSession: SshSandboxSession;
};

export function createVefaasSandboxBackendFactory(
  params: CreateVefaasSandboxBackendFactoryParams,
): SandboxBackendFactory {
  return async (createParams) =>
    await createVefaasSandboxBackend({
      ...params,
      createParams,
    });
}

export function createVefaasSandboxBackendManager(params: {
  pluginConfig: ResolvedVefaasPluginConfig;
}): SandboxBackendManager {
  return {
    async describeRuntime({ entry, config }) {
      const pluginConfig = resolveVefaasPluginConfigFromConfig(config, params.pluginConfig);
      const context: VefaasProvisionerContext = {
        config: pluginConfig,
        sandboxName: entry.containerName,
      };
      const result = await runVefaasProvisioner({
        context,
        action: "get",
      });
      return {
        running: result.code === 0,
        actualConfigLabel: pluginConfig.image,
        configLabelMatch: entry.image === pluginConfig.image,
      };
    },
    async removeRuntime({ entry, config }) {
      const pluginConfig = resolveVefaasPluginConfigFromConfig(config, params.pluginConfig);
      await runVefaasProvisioner({
        context: {
          config: pluginConfig,
          sandboxName: entry.containerName,
        },
        action: "delete",
      });
    },
  };
}

async function createVefaasSandboxBackend(params: {
  pluginConfig: ResolvedVefaasPluginConfig;
  createParams: CreateSandboxBackendParams;
}): Promise<SandboxBackendHandle> {
  if ((params.createParams.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("VEFaaS sandbox backend does not support sandbox.docker.binds.");
  }

  const sandboxName = buildVefaasSandboxName(params.createParams.scopeKey);
  const impl = new VefaasSandboxBackendImpl({
    createParams: params.createParams,
    context: {
      config: params.pluginConfig,
      sandboxName,
    },
  });
  return impl.asHandle();
}

class VefaasSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;
  private remoteSeedPending = false;

  constructor(
    private readonly params: {
      createParams: CreateSandboxBackendParams;
      context: VefaasProvisionerContext;
    },
  ) {}

  asHandle(): SandboxBackendHandle & {
    remoteWorkspaceDir: string;
    remoteAgentWorkspaceDir: string;
    runRemoteShellScript(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
  } {
    return {
      id: "vefaas",
      runtimeId: this.params.context.sandboxName,
      runtimeLabel: this.params.context.sandboxName,
      workdir: this.params.context.config.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      configLabel: this.params.context.config.image,
      configLabelKind: "Image",
      remoteWorkspaceDir: this.params.context.config.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: this.params.context.config.remoteAgentWorkspaceDir,
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        await this.ensureSandboxExists();
        await this.maybeSeedRemoteWorkspace();
        const sshSession = await createVefaasSshSession({
          context: this.params.context,
        });
        const remoteCommand = buildExecRemoteCommand({
          command,
          workdir: workdir ?? this.params.context.config.remoteWorkspaceDir,
          env,
        });
        return {
          argv: buildSshSandboxArgv({
            session: sshSession,
            remoteCommand,
            tty: usePty,
          }),
          env: sanitizeEnvVars(process.env).allowed,
          stdinMode: "pipe-open",
          finalizeToken: { sshSession } satisfies PendingExec,
        };
      },
      finalizeExec: async ({ token }) => {
        const sshSession = (token as PendingExec | undefined)?.sshSession;
        if (sshSession) {
          await disposeSshSandboxSession(sshSession);
        }
      },
      runShellCommand: async (command) => await this.runRemoteShellScript(command),
      createFsBridge: ({ sandbox }) =>
        createRemoteShellSandboxFsBridge({
          sandbox,
          runtime: this.asHandle(),
        }),
      runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
    };
  }

  async runRemoteShellScript(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    await this.ensureSandboxExists();
    await this.maybeSeedRemoteWorkspace();
    const session = await createVefaasSshSession({
      context: this.params.context,
    });
    try {
      return await runSshSandboxCommand({
        session,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          params.script,
          "openclaw-vefaas-fs",
          ...(params.args ?? []),
        ]),
        stdin: params.stdin,
        allowFailure: params.allowFailure,
        signal: params.signal,
      });
    } finally {
      await disposeSshSandboxSession(session);
    }
  }

  private async ensureSandboxExists(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    this.ensurePromise = this.ensureSandboxExistsInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureSandboxExistsInner(): Promise<void> {
    const getResult = await runVefaasProvisioner({
      context: this.params.context,
      action: "get",
      cwd: this.params.createParams.workspaceDir,
    });
    if (getResult.code === 0) {
      return;
    }

    const createResult = await runVefaasProvisioner({
      context: this.params.context,
      action: "create",
      spec: buildVefaasSandboxCreateSpec(this.params.context.config),
      cwd: this.params.createParams.workspaceDir,
      timeoutMs: Math.max(this.params.context.config.timeoutMs, 300_000),
    });
    if (createResult.code !== 0) {
      throw new Error(createResult.stderr.trim() || "VEFaaS sandbox create failed");
    }
    this.remoteSeedPending = true;
  }

  private async maybeSeedRemoteWorkspace(): Promise<void> {
    if (!this.remoteSeedPending) {
      return;
    }
    this.remoteSeedPending = false;
    try {
      await this.seedRemoteWorkspace();
    } catch (error) {
      this.remoteSeedPending = true;
      throw error;
    }
  }

  private async seedRemoteWorkspace(): Promise<void> {
    const session = await createVefaasSshSession({
      context: this.params.context,
    });
    try {
      await this.replaceRemoteDirectoryFromLocal(
        session,
        this.params.createParams.workspaceDir,
        this.params.context.config.remoteWorkspaceDir,
      );
      if (
        this.params.createParams.cfg.workspaceAccess !== "none" &&
        path.resolve(this.params.createParams.agentWorkspaceDir) !==
          path.resolve(this.params.createParams.workspaceDir)
      ) {
        await this.replaceRemoteDirectoryFromLocal(
          session,
          this.params.createParams.agentWorkspaceDir,
          this.params.context.config.remoteAgentWorkspaceDir,
        );
      }
    } finally {
      await disposeSshSandboxSession(session);
    }
  }

  private async replaceRemoteDirectoryFromLocal(
    session: SshSandboxSession,
    localDir: string,
    remoteDir: string,
  ): Promise<void> {
    await runSshSandboxCommand({
      session,
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        'mkdir -p -- "$1" && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
        "openclaw-vefaas-clear",
        remoteDir,
      ]),
    });
    await uploadDirectoryToSshTarget({
      session,
      localDir,
      remoteDir,
    });
  }
}

function resolveVefaasPluginConfigFromConfig(
  config: OpenClawConfig,
  fallback: ResolvedVefaasPluginConfig,
): ResolvedVefaasPluginConfig {
  const pluginConfig = config.plugins?.entries?.["vefaas-sandbox"]?.config;
  if (!pluginConfig) {
    return fallback;
  }
  return resolveVefaasPluginConfig(pluginConfig);
}

function buildVefaasSandboxName(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = Array.from(trimmed).reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `openclaw-vefaas-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
