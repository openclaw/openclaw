import type {
  CreateSandboxBackendParams,
  OpenClawConfig,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SandboxBackendManager,
  SandboxConfig,
  SandboxDockerConfig,
} from "openclaw/plugin-sdk/sandbox";
import {
  computeSandboxConfigHash,
  defaultRuntime,
  formatCliCommand,
  markOpenClawExecEnv,
  readRegistry,
  resolveSandboxAgentId,
  resolveSandboxConfigForAgent,
  resolveSandboxScopeKey,
  SANDBOX_AGENT_WORKSPACE_MOUNT,
  sanitizeEnvVars,
  slugifySessionKey,
  updateRegistry,
  validateBindMounts,
} from "openclaw/plugin-sdk/sandbox";
import {
  assertAppleContainerSystemRunning,
  inspectAppleContainer,
  runAppleContainerCli,
} from "./cli.js";
import type { ResolvedAppleContainerPluginConfig } from "./config.js";
import { resolveAppleContainerPluginConfig } from "./config.js";

const HOT_CONTAINER_WINDOW_MS = 5 * 60 * 1000;

type CreateAppleContainerSandboxBackendFactoryParams = {
  pluginConfig: ResolvedAppleContainerPluginConfig;
};

function buildAppleContainerExecArgs(params: {
  containerName: string;
  command: string;
  workdir?: string;
  env: Record<string, string>;
  tty: boolean;
}): string[] {
  const args = ["exec", "-i"];
  if (params.tty) {
    args.push("-t");
  }
  if (params.workdir) {
    args.push("--workdir", params.workdir);
  }
  for (const [key, value] of Object.entries(params.env)) {
    // Skip PATH; handled via OPENCLAW_PREPEND_PATH to avoid poisoning the
    // container's executable lookup with host paths.
    if (key === "PATH") {
      continue;
    }
    args.push("--env", `${key}=${value}`);
  }
  const hasCustomPath = typeof params.env.PATH === "string" && params.env.PATH.length > 0;
  if (hasCustomPath) {
    args.push("--env", `OPENCLAW_PREPEND_PATH=${params.env.PATH}`);
  }
  const pathExport = hasCustomPath
    ? 'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; '
    : "";
  args.push(params.containerName, "/bin/sh", "-lc", `${pathExport}${params.command}`);
  return args;
}

function normalizeDockerLimit(value?: string | number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function formatUlimitValue(
  name: string,
  value: string | number | { soft?: number; hard?: number },
): string | null {
  if (!name.trim()) {
    return null;
  }
  if (typeof value === "number" || typeof value === "string") {
    const raw = String(value).trim();
    return raw ? `${name}=${raw}` : null;
  }
  const soft = typeof value.soft === "number" ? Math.max(0, value.soft) : undefined;
  const hard = typeof value.hard === "number" ? Math.max(0, value.hard) : undefined;
  if (soft === undefined && hard === undefined) {
    return null;
  }
  if (soft === undefined) {
    return `${name}=${hard}`;
  }
  if (hard === undefined) {
    return `${name}=${soft}`;
  }
  return `${name}=${soft}:${hard}`;
}

function formatSandboxRecreateHint(params: { scope: SandboxConfig["scope"]; sessionKey: string }) {
  if (params.scope === "session") {
    return formatCliCommand(`openclaw sandbox recreate --session ${params.sessionKey}`);
  }
  if (params.scope === "agent") {
    const agentId = resolveSandboxAgentId(params.sessionKey) ?? "main";
    return formatCliCommand(`openclaw sandbox recreate --agent ${agentId}`);
  }
  return formatCliCommand("openclaw sandbox recreate --all");
}

function buildAppleContainerName(params: { prefix: string; scopeKey: string }): string {
  const slug = params.scopeKey === "shared" ? "shared" : slugifySessionKey(params.scopeKey);
  return `${params.prefix}${slug}`.slice(0, 63);
}

function buildAppleContainerCreateArgs(params: {
  name: string;
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  agentWorkspaceDir: string;
  workspaceAccess: SandboxConfig["workspaceAccess"];
  scopeKey: string;
  createdAtMs?: number;
  configHash?: string;
}): string[] {
  validateBindMounts(params.cfg.binds, {
    allowedSourceRoots: [params.workspaceDir, params.agentWorkspaceDir],
    allowSourcesOutsideAllowedRoots: params.cfg.dangerouslyAllowExternalBindSources === true,
    allowReservedContainerTargets: params.cfg.dangerouslyAllowReservedContainerTargets === true,
  });

  const createdAtMs = params.createdAtMs ?? Date.now();
  const args = ["create", "--name", params.name];
  args.push("--label", "openclaw.sandbox=1");
  args.push("--label", `openclaw.sessionKey=${params.scopeKey}`);
  args.push("--label", `openclaw.createdAtMs=${createdAtMs}`);
  if (params.configHash) {
    args.push("--label", `openclaw.configHash=${params.configHash}`);
  }
  if (params.cfg.readOnlyRoot) {
    args.push("--read-only");
  }
  for (const entry of params.cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }
  const normalizedNetwork = normalizeAppleContainerNetwork(params.cfg.network);
  if (normalizedNetwork) {
    args.push("--network", normalizedNetwork);
  }
  if (params.cfg.user) {
    args.push("--user", params.cfg.user);
  }
  const envSanitization = sanitizeEnvVars(params.cfg.env ?? {});
  for (const [key, value] of Object.entries(markOpenClawExecEnv(envSanitization.allowed))) {
    args.push("--env", `${key}=${value}`);
  }
  const memory = normalizeDockerLimit(params.cfg.memory);
  if (memory) {
    args.push("--memory", memory);
  }
  if (typeof params.cfg.cpus === "number" && params.cfg.cpus > 0) {
    args.push("--cpus", String(params.cfg.cpus));
  }
  for (const [name, value] of Object.entries(params.cfg.ulimits ?? {})) {
    const formatted = formatUlimitValue(name, value);
    if (formatted) {
      args.push("--ulimit", formatted);
    }
  }
  args.push(
    "--volume",
    buildVolumeSpec({
      source: params.workspaceDir,
      target: params.cfg.workdir,
      readOnly: params.workspaceAccess !== "rw",
    }),
  );
  if (params.workspaceAccess !== "none" && params.workspaceDir !== params.agentWorkspaceDir) {
    args.push(
      "--volume",
      buildVolumeSpec({
        source: params.agentWorkspaceDir,
        target: SANDBOX_AGENT_WORKSPACE_MOUNT,
        readOnly: params.workspaceAccess === "ro",
      }),
    );
  }
  for (const bind of params.cfg.binds ?? []) {
    args.push("--volume", bind);
  }
  args.push("--workdir", params.cfg.workdir, params.cfg.image, "sleep", "infinity");
  return args;
}

function normalizeAppleContainerNetwork(network: string | undefined): string | undefined {
  const trimmed = network?.trim();
  if (!trimmed || trimmed === "default" || trimmed === "bridge") {
    return undefined;
  }
  return trimmed;
}

function buildVolumeSpec(params: { source: string; target: string; readOnly: boolean }): string {
  return `${params.source}:${params.target}${params.readOnly ? ":ro" : ""}`;
}

function isDefaultAppleContainerCompatCapDrop(capDrop: string[]): boolean {
  return capDrop.length === 1 && capDrop[0] === "ALL";
}

function assertAppleContainerSupportedConfig(cfg: SandboxConfig): void {
  if (cfg.browser.enabled) {
    throw new Error('Sandbox backend "apple-container" does not support browser sandboxes yet.');
  }
  if (cfg.docker.network.startsWith("container:")) {
    throw new Error(
      `Sandbox backend "apple-container" does not support Docker namespace join semantics such as "${cfg.docker.network}".`,
    );
  }
  if (cfg.docker.capDrop.length > 0 && !isDefaultAppleContainerCompatCapDrop(cfg.docker.capDrop)) {
    throw new Error('Sandbox backend "apple-container" does not support sandbox.docker.capDrop.');
  }
  if (cfg.docker.seccompProfile) {
    throw new Error(
      'Sandbox backend "apple-container" does not support sandbox.docker.seccompProfile.',
    );
  }
  if (cfg.docker.apparmorProfile) {
    throw new Error(
      'Sandbox backend "apple-container" does not support sandbox.docker.apparmorProfile.',
    );
  }
  if (typeof cfg.docker.pidsLimit === "number" && cfg.docker.pidsLimit > 0) {
    throw new Error('Sandbox backend "apple-container" does not support sandbox.docker.pidsLimit.');
  }
  if (cfg.docker.memorySwap !== undefined) {
    throw new Error(
      'Sandbox backend "apple-container" does not support sandbox.docker.memorySwap.',
    );
  }
  if ((cfg.docker.extraHosts?.length ?? 0) > 0) {
    throw new Error(
      'Sandbox backend "apple-container" does not support sandbox.docker.extraHosts.',
    );
  }
}

async function createAppleContainer(params: {
  pluginConfig: ResolvedAppleContainerPluginConfig;
  name: string;
  cfg: SandboxConfig;
  workspaceDir: string;
  agentWorkspaceDir: string;
  scopeKey: string;
  configHash: string;
}): Promise<void> {
  const createArgs = buildAppleContainerCreateArgs({
    name: params.name,
    cfg: params.cfg.docker,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    workspaceAccess: params.cfg.workspaceAccess,
    scopeKey: params.scopeKey,
    configHash: params.configHash,
  });
  await runAppleContainerCli({
    config: params.pluginConfig,
    args: createArgs,
  });
  await runAppleContainerCli({
    config: params.pluginConfig,
    args: ["start", params.name],
  });
  if (params.cfg.docker.setupCommand?.trim()) {
    await runAppleContainerCli({
      config: params.pluginConfig,
      args: ["exec", "-i", params.name, "/bin/sh", "-lc", params.cfg.docker.setupCommand],
    });
  }
}

type AppleContainerSandboxBackendImplParams = {
  createParams: CreateSandboxBackendParams;
  pluginConfig: ResolvedAppleContainerPluginConfig;
  containerName: string;
};

class AppleContainerSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;

  constructor(private readonly params: AppleContainerSandboxBackendImplParams) {}

  async ensureRuntime(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    this.ensurePromise = this.ensureRuntimeInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  asHandle(): SandboxBackendHandle {
    return {
      id: "apple-container",
      runtimeId: this.params.containerName,
      runtimeLabel: this.params.containerName,
      workdir: this.params.createParams.cfg.docker.workdir,
      env: this.params.createParams.cfg.docker.env,
      configLabel: this.params.createParams.cfg.docker.image,
      configLabelKind: "Image",
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        await this.ensureRuntime();
        return {
          argv: [
            this.params.pluginConfig.command,
            ...buildAppleContainerExecArgs({
              containerName: this.params.containerName,
              command,
              workdir: workdir ?? this.params.createParams.cfg.docker.workdir,
              env,
              tty: usePty,
            }),
          ],
          env: process.env,
          stdinMode: usePty ? "pipe-open" : "pipe-closed",
        };
      },
      runShellCommand: async (command) => await this.runShellCommand(command),
    };
  }

  private async ensureRuntimeInner(): Promise<void> {
    assertAppleContainerSupportedConfig(this.params.createParams.cfg);
    await assertAppleContainerSystemRunning(this.params.pluginConfig);
    const expectedHash = computeSandboxConfigHash({
      docker: this.params.createParams.cfg.docker,
      workspaceAccess: this.params.createParams.cfg.workspaceAccess,
      workspaceDir: this.params.createParams.workspaceDir,
      agentWorkspaceDir: this.params.createParams.agentWorkspaceDir,
    });
    const now = Date.now();
    const inspect = await inspectAppleContainer({
      config: this.params.pluginConfig,
      containerId: this.params.containerName,
    });
    let hasContainer = Boolean(inspect?.configuration?.id);
    let running = inspect?.status === "running";
    let currentHash = inspect?.configuration?.labels?.["openclaw.configHash"] ?? null;
    let hashMismatch = false;
    let registryEntry:
      | {
          lastUsedAtMs: number;
          configHash?: string;
        }
      | undefined;

    if (hasContainer) {
      const registry = await readRegistry();
      registryEntry = registry.entries.find(
        (entry) => entry.containerName === this.params.containerName,
      );
      currentHash = currentHash ?? registryEntry?.configHash ?? null;
      hashMismatch = !currentHash || currentHash !== expectedHash;
      if (hashMismatch) {
        const lastUsedAtMs = registryEntry?.lastUsedAtMs;
        const isHot =
          running &&
          (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_CONTAINER_WINDOW_MS);
        if (isHot) {
          const hint = formatSandboxRecreateHint({
            scope: this.params.createParams.cfg.scope,
            sessionKey: this.params.createParams.scopeKey,
          });
          defaultRuntime.log(
            `Sandbox config changed for ${this.params.containerName} (recently used). Recreate to apply: ${hint}`,
          );
        } else {
          await runAppleContainerCli({
            config: this.params.pluginConfig,
            args: ["delete", "--force", this.params.containerName],
            allowFailure: true,
          });
          hasContainer = false;
          running = false;
        }
      }
    }

    if (!hasContainer) {
      await createAppleContainer({
        pluginConfig: this.params.pluginConfig,
        name: this.params.containerName,
        cfg: this.params.createParams.cfg,
        workspaceDir: this.params.createParams.workspaceDir,
        agentWorkspaceDir: this.params.createParams.agentWorkspaceDir,
        scopeKey: this.params.createParams.scopeKey,
        configHash: expectedHash,
      });
    } else if (!running) {
      await runAppleContainerCli({
        config: this.params.pluginConfig,
        args: ["start", this.params.containerName],
      });
      running = true;
    }

    await updateRegistry({
      containerName: this.params.containerName,
      backendId: "apple-container",
      runtimeLabel: this.params.containerName,
      sessionKey: this.params.createParams.scopeKey,
      createdAtMs: now,
      lastUsedAtMs: now,
      image: this.params.createParams.cfg.docker.image,
      configLabelKind: "Image",
      configHash: hashMismatch && running ? (currentHash ?? undefined) : expectedHash,
    });
  }

  private async runShellCommand(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    await this.ensureRuntime();
    const args = ["exec", "-i"];
    if (this.params.createParams.cfg.docker.user) {
      args.push("--user", this.params.createParams.cfg.docker.user);
    }
    if (this.params.createParams.cfg.docker.workdir) {
      args.push("--workdir", this.params.createParams.cfg.docker.workdir);
    }
    args.push(
      this.params.containerName,
      "/bin/sh",
      "-c",
      params.script,
      "openclaw-sandbox-fs",
      ...(params.args ?? []),
    );
    return await runAppleContainerCli({
      config: this.params.pluginConfig,
      args,
      input: params.stdin,
      allowFailure: params.allowFailure,
      signal: params.signal,
    });
  }
}

export function createAppleContainerSandboxBackendFactory(
  params: CreateAppleContainerSandboxBackendFactoryParams,
): SandboxBackendFactory {
  return async (createParams) => {
    assertAppleContainerSupportedConfig(createParams.cfg);
    const containerName = buildAppleContainerName({
      prefix: createParams.cfg.docker.containerPrefix,
      scopeKey: createParams.scopeKey,
    });
    const impl = new AppleContainerSandboxBackendImpl({
      createParams,
      pluginConfig: params.pluginConfig,
      containerName,
    });
    await impl.ensureRuntime();
    return impl.asHandle();
  };
}

export function createAppleContainerSandboxBackendManager(params: {
  pluginConfig: ResolvedAppleContainerPluginConfig;
}): SandboxBackendManager {
  return {
    async describeRuntime({ entry, config, agentId }) {
      try {
        const pluginConfig = resolveAppleContainerPluginConfigFromConfig(
          config,
          params.pluginConfig,
        );
        const cfg = resolveSandboxConfigForAgent(config, agentId);
        const inspect = await inspectAppleContainer({
          config: pluginConfig,
          containerId: entry.containerName,
        });
        return {
          running: inspect?.status === "running",
          actualConfigLabel: inspect?.configuration?.image?.reference ?? entry.image,
          configLabelMatch:
            (inspect?.configuration?.image?.reference ?? entry.image) === cfg.docker.image,
        };
      } catch {
        return {
          running: false,
          actualConfigLabel: entry.image,
          configLabelMatch: false,
        };
      }
    },
    async removeRuntime({ entry, config }) {
      try {
        const pluginConfig = resolveAppleContainerPluginConfigFromConfig(
          config,
          params.pluginConfig,
        );
        await runAppleContainerCli({
          config: pluginConfig,
          args: ["delete", "--force", entry.containerName],
          allowFailure: true,
        });
      } catch {
        // ignore removal failures
      }
    },
  };
}

function resolveAppleContainerPluginConfigFromConfig(
  config: OpenClawConfig,
  fallback: ResolvedAppleContainerPluginConfig,
): ResolvedAppleContainerPluginConfig {
  const pluginConfig = config.plugins?.entries?.["apple-container"]?.config;
  if (!pluginConfig) {
    return fallback;
  }
  return resolveAppleContainerPluginConfig(pluginConfig);
}
