import {
  appendReadOnlyWorkspaceSkillMountArgs,
  appendWorkspaceMountArgs,
  buildDockerExecArgs,
  buildSandboxCreateArgs,
  computeSandboxConfigHash,
  formatReadOnlyWorkspaceSkillMountHashState,
  readSandboxRegistryEntry,
  resolveDockerEnvPolicyEpoch,
  resolveReadOnlyWorkspaceSkillMounts,
  resolveSandboxConfigForAgent,
  SANDBOX_MOUNT_FORMAT_VERSION,
  slugifySessionKey,
  type CreateSandboxBackendParams,
  type SandboxBackendCommandParams,
  type SandboxBackendFactory,
  type SandboxBackendHandle,
  type SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import type { PodmanPluginConfig } from "./config.js";
import {
  execPodman,
  execPodmanRaw,
  podmanContainerState,
  readPodmanContainerLabel,
} from "./podman.js";

type PodmanSandboxBackendParams = {
  pluginConfig: PodmanPluginConfig;
};

const HOT_CONTAINER_WINDOW_MS = 5 * 60 * 1000;
const PODMAN_USERNS_CONFIG_EPOCH = "podman-keep-id-v1";

function buildContainerName(params: CreateSandboxBackendParams): string {
  const scopeKey =
    params.cfg.scope === "shared"
      ? "shared"
      : params.cfg.scope === "session"
        ? params.sessionKey
        : params.scopeKey;
  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
  return `${params.cfg.docker.containerPrefix}${slug}`.slice(0, 63);
}

function assertSupportedPodmanConfig(params: CreateSandboxBackendParams): void {
  if (params.cfg.docker.gpus) {
    throw new Error(
      'Podman sandbox backend does not support sandbox.docker.gpus. Use backend "docker" for Docker GPU runtime support, or configure GPU devices through a custom Podman image/runtime outside this backend.',
    );
  }
  if (params.cfg.browser.enabled) {
    throw new Error("Podman sandbox backend does not support browser sandboxes yet.");
  }
}

async function ensurePodmanImage(config: PodmanPluginConfig, image: string): Promise<void> {
  const result = await execPodman(config, ["image", "inspect", image], { allowFailure: true });
  if (result.code === 0) {
    return;
  }
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(
    `Podman sandbox image not found: ${image}. Build or pull it into the selected Podman store first.${detail ? ` Podman said: ${detail}` : ""}`,
  );
}

function appendCustomBinds(args: string[], binds: readonly string[] | undefined): void {
  for (const bind of binds ?? []) {
    args.push("-v", bind);
  }
}

function currentUserForKeepId(): string | null {
  const getuid = process.getuid;
  const getgid = process.getgid;
  if (typeof getuid !== "function" || typeof getgid !== "function") {
    return null;
  }
  return `${getuid()}:${getgid()}`;
}

function appendPodmanUserNamespaceArgs(args: string[], cfg: CreateSandboxBackendParams["cfg"]) {
  if (cfg.docker.user) {
    return;
  }
  const user = currentUserForKeepId();
  if (!user) {
    return;
  }
  // Rootless Podman needs keep-id so the sandbox can write workspace bind mounts.
  // When callers set docker.user explicitly, that ownership contract is theirs.
  args.push("--userns", "keep-id", "--user", user);
}

function computePodmanConfigHash(params: CreateSandboxBackendParams): string {
  const readOnlyWorkspaceSkillMounts = resolveReadOnlyWorkspaceSkillMounts({
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir: params.cfg.docker.workdir,
    workspaceAccess: params.cfg.workspaceAccess,
  });
  const genericHash = computeSandboxConfigHash({
    docker: params.cfg.docker,
    dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(params.cfg.docker.env),
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    readOnlyWorkspaceSkillMounts: formatReadOnlyWorkspaceSkillMountHashState(
      readOnlyWorkspaceSkillMounts,
    ),
  });
  return `${genericHash}:${PODMAN_USERNS_CONFIG_EPOCH}`;
}

async function createPodmanContainer(params: {
  pluginConfig: PodmanPluginConfig;
  createParams: CreateSandboxBackendParams;
  containerName: string;
  configHash: string;
}) {
  const { createParams } = params;
  await ensurePodmanImage(params.pluginConfig, createParams.cfg.docker.image);
  const readOnlyWorkspaceSkillMounts = resolveReadOnlyWorkspaceSkillMounts({
    workspaceDir: createParams.workspaceDir,
    agentWorkspaceDir: createParams.agentWorkspaceDir,
    skillsWorkspaceDir: createParams.skillsWorkspaceDir,
    workdir: createParams.cfg.docker.workdir,
    workspaceAccess: createParams.cfg.workspaceAccess,
  });
  const args = buildSandboxCreateArgs({
    name: params.containerName,
    cfg: createParams.cfg.docker,
    scopeKey: createParams.scopeKey,
    configHash: params.configHash,
    includeBinds: false,
    bindSourceRoots: [createParams.workspaceDir, createParams.agentWorkspaceDir],
  });
  appendPodmanUserNamespaceArgs(args, createParams.cfg);
  args.push("--workdir", createParams.cfg.docker.workdir);
  appendWorkspaceMountArgs({
    args,
    workspaceDir: createParams.workspaceDir,
    agentWorkspaceDir: createParams.agentWorkspaceDir,
    skillsWorkspaceDir: createParams.skillsWorkspaceDir,
    workdir: createParams.cfg.docker.workdir,
    workspaceAccess: createParams.cfg.workspaceAccess,
    readOnlyWorkspaceSkillMounts,
    includeReadOnlyWorkspaceSkillMounts: false,
  });
  appendCustomBinds(args, createParams.cfg.docker.binds);
  appendReadOnlyWorkspaceSkillMountArgs({
    args,
    readOnlyWorkspaceSkillMounts,
  });
  args.push(createParams.cfg.docker.image, "sleep", "infinity");
  await execPodman(params.pluginConfig, args);
  await execPodman(params.pluginConfig, ["start", params.containerName]);
  const setupCommand = createParams.cfg.docker.setupCommand?.trim();
  if (setupCommand) {
    await execPodman(params.pluginConfig, [
      "exec",
      "-i",
      params.containerName,
      "/bin/sh",
      "-lc",
      setupCommand,
    ]);
  }
}

async function ensurePodmanContainer(params: {
  pluginConfig: PodmanPluginConfig;
  createParams: CreateSandboxBackendParams;
}): Promise<string> {
  assertSupportedPodmanConfig(params.createParams);
  const containerName = buildContainerName(params.createParams);
  const expectedHash = computePodmanConfigHash(params.createParams);
  const state = await podmanContainerState(params.pluginConfig, containerName);
  let hasContainer = state.exists;
  const running = state.running;
  if (hasContainer) {
    const currentHash = await readPodmanContainerLabel(
      params.pluginConfig,
      containerName,
      "openclaw.configHash",
    );
    if (currentHash !== expectedHash) {
      const registryEntry = (await readSandboxRegistryEntry(containerName)) ?? undefined;
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      const isHot =
        running &&
        (typeof lastUsedAtMs !== "number" || Date.now() - lastUsedAtMs < HOT_CONTAINER_WINDOW_MS);
      if (isHot) {
        // Match Docker's hot-container contract: keep recently used runtimes
        // alive so config drift does not kill active agent work mid-turn.
        return containerName;
      }
      await execPodman(params.pluginConfig, ["rm", "-f", containerName], {
        allowFailure: true,
      });
      hasContainer = false;
    }
  }
  if (!hasContainer) {
    await createPodmanContainer({
      pluginConfig: params.pluginConfig,
      createParams: params.createParams,
      containerName,
      configHash: expectedHash,
    });
  } else if (!running) {
    await execPodman(params.pluginConfig, ["start", containerName]);
  }
  return containerName;
}

function createPodmanSandboxBackendHandle(params: {
  pluginConfig: PodmanPluginConfig;
  containerName: string;
  workdir: string;
  env?: Record<string, string>;
  image: string;
}): SandboxBackendHandle {
  return {
    id: "podman",
    runtimeId: params.containerName,
    runtimeLabel: params.containerName,
    workdir: params.workdir,
    env: params.env,
    configLabel: params.image,
    configLabelKind: "Image",
    async buildExecSpec({ command, workdir, env, usePty }) {
      const invocation = {
        command: params.pluginConfig.command,
        args: buildDockerExecArgs({
          containerName: params.containerName,
          command,
          workdir: workdir ?? params.workdir,
          env,
          tty: usePty,
        }),
      };
      if (params.pluginConfig.connection) {
        invocation.args.unshift("--connection", params.pluginConfig.connection);
      }
      if (params.pluginConfig.url) {
        invocation.args.unshift("--url", params.pluginConfig.url);
      }
      return {
        argv: [invocation.command, ...invocation.args],
        env: process.env,
        stdinMode: usePty ? "pipe-open" : "pipe-closed",
      };
    },
    runShellCommand(command) {
      return runPodmanSandboxShellCommand({
        pluginConfig: params.pluginConfig,
        containerName: params.containerName,
        ...command,
      });
    },
  };
}

export function runPodmanSandboxShellCommand(
  params: {
    pluginConfig: PodmanPluginConfig;
    containerName: string;
  } & SandboxBackendCommandParams,
) {
  const podmanArgs = [
    "exec",
    "-i",
    params.containerName,
    "sh",
    "-c",
    params.script,
    "openclaw-sandbox-fs",
  ];
  if (params.args?.length) {
    podmanArgs.push(...params.args);
  }
  return execPodmanRaw(params.pluginConfig, podmanArgs, {
    input: params.stdin,
    allowFailure: params.allowFailure,
    signal: params.signal,
  });
}

export function createPodmanSandboxBackendFactory(
  params: PodmanSandboxBackendParams,
): SandboxBackendFactory {
  return async (createParams) => {
    const containerName = await ensurePodmanContainer({
      pluginConfig: params.pluginConfig,
      createParams,
    });
    return createPodmanSandboxBackendHandle({
      pluginConfig: params.pluginConfig,
      containerName,
      workdir: createParams.cfg.docker.workdir,
      env: createParams.cfg.docker.env,
      image: createParams.cfg.docker.image,
    });
  };
}

export function createPodmanSandboxBackendManager(params: {
  pluginConfig: PodmanPluginConfig;
}): SandboxBackendManager {
  return {
    async describeRuntime({ entry, config, agentId }) {
      const state = await podmanContainerState(params.pluginConfig, entry.containerName);
      let actualConfigLabel = entry.image;
      if (state.exists) {
        const result = await execPodman(
          params.pluginConfig,
          ["inspect", "-f", "{{.Config.Image}}", entry.containerName],
          { allowFailure: true },
        );
        if (result.code === 0) {
          actualConfigLabel = result.stdout.trim() || actualConfigLabel;
        }
      }
      const configuredImage = resolveSandboxConfigForAgent(config, agentId).docker.image;
      return {
        running: state.running,
        actualConfigLabel,
        configLabelMatch: actualConfigLabel === configuredImage,
      };
    },
    async removeRuntime({ entry }) {
      const result = await execPodman(params.pluginConfig, ["rm", "-f", entry.containerName], {
        allowFailure: true,
      });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        if (/no such (container|object)|does not exist/iu.test(detail)) {
          return;
        }
        throw new Error(
          `Failed to remove Podman sandbox runtime ${entry.containerName}: ${detail}`,
        );
      }
    },
  };
}
