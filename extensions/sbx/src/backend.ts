// sbx plugin module implements backend behavior.
import path from "node:path";
import type {
  CreateSandboxBackendParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildSbxExecArgv,
  runSbxCli,
  runSbxExecShell,
  type SbxExecContext,
} from "./cli.js";
import type { ResolvedSbxPluginConfig } from "./config.js";

type CreateSbxSandboxBackendFactoryParams = {
  pluginConfig: ResolvedSbxPluginConfig;
};

export function createSbxSandboxBackendFactory(
  params: CreateSbxSandboxBackendFactoryParams,
): SandboxBackendFactory {
  return async (createParams) =>
    await createSbxSandboxBackend({
      pluginConfig: params.pluginConfig,
      createParams,
    });
}

export function createSbxSandboxBackendManager(params: {
  pluginConfig: ResolvedSbxPluginConfig;
}): SandboxBackendManager {
  return {
    async describeRuntime({ entry }) {
      const context: SbxExecContext = {
        config: params.pluginConfig,
        sandboxName: entry.containerName,
      };
      const running = await sbxSandboxRunning(context, entry.containerName);
      const configuredLabel = params.pluginConfig.template ?? params.pluginConfig.agent;
      return {
        running,
        actualConfigLabel: entry.image,
        configLabelMatch: entry.image === configuredLabel,
      };
    },
    async removeRuntime({ entry }) {
      const context: SbxExecContext = {
        config: params.pluginConfig,
        sandboxName: entry.containerName,
      };
      const result = await runSbxCli({
        context,
        args: ["rm", "--force", entry.containerName],
      });
      if (result.code !== 0 && !/no such|not found/i.test(result.stderr)) {
        throw new Error(
          result.stderr.trim() || `Failed to remove sbx sandbox runtime ${entry.containerName}`,
        );
      }
    },
  };
}

async function createSbxSandboxBackend(params: {
  pluginConfig: ResolvedSbxPluginConfig;
  createParams: CreateSandboxBackendParams;
}): Promise<SandboxBackendHandle> {
  if ((params.createParams.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("sbx sandbox backend does not support sandbox.docker.binds.");
  }

  const sandboxName = buildSbxSandboxName(params.createParams.scopeKey);
  const impl = new SbxSandboxBackendImpl({
    pluginConfig: params.pluginConfig,
    createParams: params.createParams,
    sandboxName,
  });
  const configLabel = params.pluginConfig.template ?? params.pluginConfig.agent;

  return {
    id: "sbx",
    runtimeId: sandboxName,
    runtimeLabel: sandboxName,
    // sbx bind-mounts the host workspace at the same path, so the container
    // workdir is the host workspace dir.
    workdir: params.createParams.workspaceDir,
    env: params.createParams.cfg.docker.env,
    configLabel,
    configLabelKind: params.pluginConfig.template ? "Image" : "Agent",
    async buildExecSpec({ command, workdir, env, usePty }) {
      await impl.ensureSandboxExists();
      return {
        argv: buildSbxExecArgv({
          config: params.pluginConfig,
          sandboxName,
          command,
          workdir: workdir ?? params.createParams.workspaceDir,
          env,
          usePty,
        }),
        env: process.env,
        stdinMode: usePty ? "pipe-open" : "pipe-closed",
      };
    },
    async runShellCommand(command) {
      return await impl.runShellCommand(command);
    },
  };
}

class SbxSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;

  constructor(
    private readonly params: {
      pluginConfig: ResolvedSbxPluginConfig;
      createParams: CreateSandboxBackendParams;
      sandboxName: string;
    },
  ) {}

  private get context(): SbxExecContext {
    return { config: this.params.pluginConfig, sandboxName: this.params.sandboxName };
  }

  async runShellCommand(
    command: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    await this.ensureSandboxExists();
    return await runSbxExecShell({
      config: this.params.pluginConfig,
      sandboxName: this.params.sandboxName,
      script: command.script,
      args: command.args,
      stdin: command.stdin,
      allowFailure: command.allowFailure,
      signal: command.signal,
    });
  }

  async ensureSandboxExists(): Promise<void> {
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
    if (await sbxSandboxExists(this.context, this.params.sandboxName)) {
      return;
    }
    const createArgs = [
      "create",
      this.params.pluginConfig.agent,
      ...this.buildWorkspaceArgs(),
      "--name",
      this.params.sandboxName,
      "--quiet",
      ...(this.params.pluginConfig.template
        ? ["--template", this.params.pluginConfig.template]
        : []),
      ...(typeof this.params.pluginConfig.cpus === "number"
        ? ["--cpus", String(this.params.pluginConfig.cpus)]
        : []),
      ...(this.params.pluginConfig.memory
        ? ["--memory", this.params.pluginConfig.memory]
        : []),
      ...(this.params.pluginConfig.clone ? ["--clone"] : []),
    ];
    const result = await runSbxCli({
      context: this.context,
      args: createArgs,
      cwd: this.params.createParams.workspaceDir,
      timeoutMs: Math.max(this.params.pluginConfig.timeoutMs, 300_000),
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "sbx create failed");
    }
  }

  private buildWorkspaceArgs(): string[] {
    const workspaceDir = this.params.createParams.workspaceDir;
    const args = [workspaceDir];
    const workspaceAccess = this.params.createParams.cfg.workspaceAccess;
    const agentWorkspaceDir = this.params.createParams.agentWorkspaceDir;
    if (
      workspaceAccess !== "none" &&
      path.resolve(agentWorkspaceDir) !== path.resolve(workspaceDir)
    ) {
      args.push(workspaceAccess === "ro" ? `${agentWorkspaceDir}:ro` : agentWorkspaceDir);
    }
    if (workspaceAccess === "rw" && this.params.createParams.skillsWorkspaceDir) {
      args.push(this.params.createParams.skillsWorkspaceDir);
    }
    return args;
  }
}

type SbxListEntry = { name?: string; status?: string };

async function listSbxSandboxes(context: SbxExecContext): Promise<SbxListEntry[]> {
  const result = await runSbxCli({ context, args: ["ls", "--json"] });
  if (result.code !== 0) {
    return [];
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as SbxListEntry[]) : [];
  } catch {
    return [];
  }
}

async function sbxSandboxExists(context: SbxExecContext, name: string): Promise<boolean> {
  return (await listSbxSandboxes(context)).some((entry) => entry.name === name);
}

async function sbxSandboxRunning(context: SbxExecContext, name: string): Promise<boolean> {
  const entry = (await listSbxSandboxes(context)).find((item) => item.name === name);
  return entry?.status?.toLowerCase() === "running";
}

export function buildSbxSandboxName(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = Array.from(trimmed).reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `openclaw-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
