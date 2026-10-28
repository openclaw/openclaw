import { createContainerEnvFile } from "../../infra/container-env-file.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { buildGitHubExecLaunchArgv } from "../github-exec-launch.js";
import { CLEARED_GITHUB_CREDENTIALS } from "../github-host.js";
import type { PreparedGitHubToolEnvironment } from "../github-tool-identity.types.js";
import { buildGitLabExecLaunchArgv } from "../gitlab-exec-launch.js";
import type { prepareGitLabToolEnvironment } from "../gitlab-tool-identity.js";
import type { SandboxBackendCommandParams } from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { SANDBOX_GITHUB_CONFIG_DIR, SANDBOX_GITLAB_CONFIG_DIR } from "./constants.js";
import { containerHasTerminated } from "./container-inspect.js";
import {
  captureSandboxContainerTermination,
  removeSandboxContainerRuntime,
} from "./container-lifecycle.js";
import {
  bindDockerPersistentTarget,
  captureDockerPersistentTarget,
  dockerPersistentTargetToEngineTarget,
  dockerPersistentTargetFromEngineTarget,
  readDockerPersistentContainer,
} from "./docker-persistent-target.js";
import {
  allocateSandboxContainer,
  containerState,
  bindPodmanSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  ensureSandboxContainer,
  execContainer,
  execContainerRaw,
  PODMAN_SANDBOX_ENGINE,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
  validateSandboxContainerEngineTarget,
} from "./docker.js";
import { bindSandboxInputStager, createSandboxInputStager } from "./input-staging.js";
import { resolveSandboxContainerOnlyMounts } from "./mount-plan.js";
import {
  bindSandboxPersistentExecCapability,
  type SandboxPersistentExecCommand,
} from "./persistent-exec.types.js";
import { createSandboxProcessCleanup } from "./process-cleanup.js";
import type { SandboxRegistryEntry } from "./registry.js";

type ContainerExecFinalizeToken = () => Promise<void>;

async function createContainerSandboxBackend(
  engine: SandboxContainerEngine,
  params: CreateSandboxBackendParams,
  operatorAuthority?: AdmittedRunOperatorAuthority,
  githubIdentity?: PreparedGitHubToolEnvironment,
  gitlabIdentity?: ReturnType<typeof prepareGitLabToolEnvironment>,
): Promise<SandboxBackendHandle> {
  using phases = observeDiagnosticsTimelinePhases("attempt.setup.sandbox.backend.target");
  const assertCurrent = () => {
    operatorAuthority?.assertCurrent();
    params.assertRuntimeCurrent?.();
  };
  assertCurrent();
  if (engine.id === "podman" && params.cfg.browser.enabled) {
    throw new Error(
      "Podman sandboxing does not support browser sandboxes. Install Docker and select the docker backend, or disable sandbox.browser.enabled.",
    );
  }
  const dockerTarget = engine.id === "docker" ? await captureDockerPersistentTarget() : undefined;
  assertCurrent();
  const configuredEngine = dockerTarget ? bindDockerPersistentTarget(dockerTarget) : engine;
  phases.mark("attempt.setup.sandbox.backend.container");
  const { containerName, containerId, configHash, mountPlan, currentConfig, podmanTarget } =
    await ensureSandboxContainer({
      engine: configuredEngine,
      ...(dockerTarget ? { dockerTarget } : {}),
      scopeKey: params.scopeKey,
      workspaceDir: params.workspaceDir,
      workspaceSource: params.workspaceSource,
      assertCurrent,
      operatorAuthority,
      agentWorkspaceDir: params.agentWorkspaceDir,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      readOnlyResourceMounts: params.readOnlyResourceMounts,
      cfg: params.cfg,
      ...(params.requireCurrentConfig !== undefined
        ? { requireCurrentConfig: params.requireCurrentConfig }
        : {}),
    });
  assertCurrent();
  const boundEngine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : configuredEngine;
  // Allocation pins the generation under its lifecycle lock; never rediscover it
  // by reusable name after another admission or recreation can acquire the lock.
  phases.mark("attempt.setup.sandbox.backend.mount_snapshot");
  const containerOnlyMounts = await resolveSandboxContainerOnlyMounts({
    engine: boundEngine,
    containerName: containerId,
    assertCurrent,
  });
  assertCurrent();
  phases.mark("attempt.setup.sandbox.backend.bridge_import");
  const { createSandboxFsBridge } = await import("./fs-bridge.js");
  assertCurrent();
  phases.mark("attempt.setup.sandbox.backend.handle");
  const { workdir: defaultWorkdir, env: configuredEnv, image } = params.cfg.docker;
  const engineTarget =
    podmanTarget ?? (dockerTarget ? dockerPersistentTargetToEngineTarget(dockerTarget) : undefined);
  const run = (command: SandboxBackendCommandParams, assertCommandCurrent?: () => void) =>
    runContainerSandboxShellCommand({
      engine: boundEngine,
      containerName: containerId,
      engineTarget,
      ...command,
      assertCurrent: assertCommandCurrent,
    });
  const handle: SandboxBackendHandle = {
    id: boundEngine.id,
    runtimeId: containerName,
    runtimeLabel: containerName,
    workdir: defaultWorkdir,
    env: configuredEnv,
    configLabel: image,
    configLabelKind: "Image",
    capabilities: {
      browser: boundEngine.id === "docker",
      readOnlyResourceMounts: true,
    },
    async buildExecSpec({
      command,
      workdir,
      env: requestedEnv,
      usePty,
      stdin,
      selectedGitLabAuthor,
    }) {
      await validateSandboxContainerEngineTarget(boundEngine, engineTarget);
      const identity = githubIdentity;
      const githubProfileDir = identity?.localIdentityEnv.GH_CONFIG_DIR;
      const gitlabProfileDir = gitlabIdentity?.localIdentityEnv.GLAB_CONFIG_DIR;
      const externalCommandShell =
        (githubProfileDir || gitlabProfileDir) && process.platform === "win32"
          ? (await import("../shell-utils.js")).getShellConfig()
          : undefined;
      assertCurrent();
      const env: Record<string, string> =
        identity || gitlabIdentity
          ? {
              ...requestedEnv,
              ...identity?.credentialScrubEnv,
              ...identity?.localIdentityEnv,
              ...gitlabIdentity?.credentialScrubEnv,
              ...gitlabIdentity?.localIdentityEnv,
              ...(githubProfileDir ? { GH_CONFIG_DIR: SANDBOX_GITHUB_CONFIG_DIR } : {}),
              ...(gitlabProfileDir ? { GLAB_CONFIG_DIR: SANDBOX_GITLAB_CONFIG_DIR } : {}),
              ...(gitlabProfileDir && selectedGitLabAuthor
                ? {
                    GIT_AUTHOR_NAME: selectedGitLabAuthor.name,
                    GIT_COMMITTER_NAME: selectedGitLabAuthor.name,
                    GIT_AUTHOR_EMAIL: selectedGitLabAuthor.commitEmail,
                    GIT_COMMITTER_EMAIL: selectedGitLabAuthor.commitEmail,
                  }
                : {}),
            }
          : requestedEnv;
      const { PATH: requestedPath, ...containerEnv } = env;
      if (requestedPath) {
        containerEnv.OPENCLAW_PREPEND_PATH = requestedPath;
      }
      const envFile = await createContainerEnvFile(containerEnv);
      try {
        assertCurrent();
        const argv = [boundEngine.command, ...(boundEngine.globalArgs ?? []), "exec", "-i"];
        if (usePty) {
          argv.push("-t");
        }
        const execWorkdir = workdir ?? defaultWorkdir;
        if (execWorkdir) {
          argv.push("-w", execWorkdir);
        }
        argv.push("--env-file", envFile.path);
        if (githubProfileDir) {
          // The host launcher supplies values privately; the engine reads them by name.
          argv.push(...Object.keys(CLEARED_GITHUB_CREDENTIALS).flatMap((name) => ["--env", name]));
        }
        if (gitlabProfileDir) {
          argv.push("--env", "GITLAB_TOKEN");
        }
        // Apply the staged prepend only after login profile sourcing; direct PATH
        // injection can break the container engine's initial executable lookup.
        const pathExport = env.PATH
          ? 'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; '
          : "";
        // Use absolute path for sh to avoid dependency on PATH resolution during exec.
        argv.push(containerId, "/bin/sh", "-lc", `${pathExport}${command}`);
        const githubArgv = githubProfileDir
          ? buildGitHubExecLaunchArgv(argv, githubProfileDir, {
              githubHost: identity?.localIdentityEnv.GH_HOST,
              externalCommandShell,
            })
          : argv;
        return {
          argv: gitlabProfileDir
            ? buildGitLabExecLaunchArgv(githubArgv, gitlabProfileDir, {
                issuer: `https://${gitlabIdentity?.localIdentityEnv.GITLAB_HOST}`,
                externalCommandShell: githubProfileDir ? undefined : externalCommandShell,
              })
            : githubArgv,
          env: boundEngine.baseEnv ?? process.env,
          stdinMode: usePty || stdin ? "pipe-open" : "pipe-closed",
          finalizeToken: envFile.cleanup satisfies ContainerExecFinalizeToken,
        };
      } catch (error) {
        await envFile.cleanup();
        throw error;
      }
    },
    async finalizeExec({ token }) {
      if (token === undefined) {
        return;
      }
      if (typeof token !== "function") {
        throw new Error("Invalid container sandbox execution cleanup token.");
      }
      await token();
    },
    prepareProcessCleanup(env) {
      assertCurrent();
      const wasTerminated = captureSandboxContainerTermination(
        boundEngine,
        containerName,
        containerId,
      );
      return createSandboxProcessCleanup(
        (command) => run(command, assertCurrent),
        env,
        async (command) => {
          const settled = { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
          try {
            if (wasTerminated()) {
              return settled;
            }
            const result = await run(command);
            if (result.code === 0) {
              return result;
            }
            // A fresh authorized request may already have restarted the same ID.
            // Preserve the old lifetime's confirmed termination across either await.
            if (
              wasTerminated() ||
              (await containerHasTerminated(boundEngine, containerId, command.signal)) ||
              wasTerminated()
            ) {
              return settled;
            }
            return result;
          } catch (error) {
            if (wasTerminated()) {
              return settled;
            }
            throw error;
          }
        },
      );
    },
    runShellCommand(command) {
      return run(command, assertCurrent);
    },
  };
  handle.createFsBridge = ({ sandbox }) => {
    const bridge = createSandboxFsBridge({
      sandbox: { ...sandbox, backend: sandbox.backend ?? handle },
      containerOnlyMounts,
    });
    bindSandboxInputStager(
      bridge,
      createSandboxInputStager({
        root: params.workspaceDir,
        bridge,
        assertCurrent,
      }),
    );
    return bridge;
  };
  if (dockerTarget && configHash && currentConfig) {
    phases.mark("attempt.setup.sandbox.backend.persistent_generation");
    const container = await readDockerPersistentContainer(
      boundEngine,
      containerId,
      AbortSignal.timeout(30_000),
    );
    assertCurrent();
    if (container.kind !== "running") {
      throw new Error("The admitted Docker sandbox container ended during preparation.");
    }
    phases.mark("attempt.setup.sandbox.backend.persistent_capability");
    const allocation = structuredClone({
      cfg: params.cfg.docker,
      dockerTmpfsSource: params.cfg.dockerTmpfsSource,
      workspaceDir: params.workspaceDir,
      workspaceAccess: params.cfg.workspaceAccess,
      agentWorkspaceDir: params.agentWorkspaceDir,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      scopeKey: params.scopeKey,
      configHash,
      mountPlan,
    });
    let imageId: Promise<string> | undefined;
    const resolveImage = () => {
      assertCurrent();
      return (imageId ??= (async () => {
        const inspected = await execContainer(
          boundEngine,
          ["image", "inspect", "--format", "{{.Id}}", allocation.cfg.image],
          { signal: AbortSignal.timeout(30_000) },
        );
        assertCurrent();
        const id = inspected.stdout.trim();
        if (!/^sha256:[a-f0-9]{64}$/u.test(id)) {
          throw new Error("Persistent sandbox execution requires an immutable Docker image ID.");
        }
        return id;
      })());
    };
    const capabilityParams = {
      target: dockerTarget,
      containerId,
      containerName,
      containerStartedAt: container.startedAt,
      workdir: params.cfg.docker.workdir,
      configHash,
      imageReference: allocation.cfg.image,
      resolveImage,
      assertCurrent,
      async allocate(input: {
        name: string;
        command: SandboxPersistentExecCommand;
        labels: Record<string, string>;
        assertCurrent: () => void;
      }) {
        const assertAllocationCurrent = () => {
          assertCurrent();
          input.assertCurrent();
        };
        assertAllocationCurrent();
        const resolvedImageId = await resolveImage();
        assertAllocationCurrent();
        return await allocateSandboxContainer({
          ...allocation,
          cfg: { ...allocation.cfg, image: resolvedImageId },
          engine: boundEngine,
          name: input.name,
          command: input.command,
          labels: input.labels,
          assertCurrent: assertAllocationCurrent,
        });
      },
    };
    bindSandboxPersistentExecCapability(handle, {
      ...capabilityParams,
      async prepare(preparation) {
        const { createDockerPersistentExecCapability } =
          await import("./docker-persistent-exec.js");
        assertCurrent();
        return await createDockerPersistentExecCapability(capabilityParams).prepare(preparation);
      },
    });
  }
  return handle;
}

export async function createDockerSandboxBackend(
  params: CreateSandboxBackendParams,
  operatorAuthority?: AdmittedRunOperatorAuthority,
  githubIdentity?: PreparedGitHubToolEnvironment,
  gitlabIdentity?: ReturnType<typeof prepareGitLabToolEnvironment>,
): Promise<SandboxBackendHandle> {
  return await createContainerSandboxBackend(
    DOCKER_SANDBOX_ENGINE,
    params,
    operatorAuthority,
    githubIdentity,
    gitlabIdentity,
  );
}

export async function createPodmanSandboxBackend(
  params: CreateSandboxBackendParams,
  operatorAuthority?: AdmittedRunOperatorAuthority,
  githubIdentity?: PreparedGitHubToolEnvironment,
  gitlabIdentity?: ReturnType<typeof prepareGitLabToolEnvironment>,
): Promise<SandboxBackendHandle> {
  return await createContainerSandboxBackend(
    PODMAN_SANDBOX_ENGINE,
    params,
    operatorAuthority,
    githubIdentity,
    gitlabIdentity,
  );
}

async function runContainerSandboxShellCommand(
  params: {
    engine: SandboxContainerEngine;
    containerName: string;
    engineTarget?: SandboxContainerEngineTarget;
    assertCurrent?: () => void;
  } & SandboxBackendCommandParams,
) {
  await validateSandboxContainerEngineTarget(params.engine, params.engineTarget);
  const dockerArgs = [
    "exec",
    "-i",
    params.containerName,
    "sh",
    "-c",
    params.script,
    "openclaw-sandbox-fs",
  ];
  if (params.args?.length) {
    dockerArgs.push(...params.args);
  }
  // The engine-target probe above can outlive the admitted workspace owner.
  params.assertCurrent?.();
  return execContainerRaw(params.engine, dockerArgs, {
    input: params.stdin,
    allowFailure: params.allowFailure,
    signal: params.signal,
  });
}

function createContainerSandboxBackendManager(
  engine: SandboxContainerEngine,
): SandboxBackendManager {
  const resolveTarget = (entry: SandboxRegistryEntry) => {
    if (engine.id !== "podman") {
      return entry.backendTarget;
    }
    if (entry.backendTarget) {
      return entry.backendTarget;
    }
    throw Object.assign(
      new Error(
        `Podman sandbox runtime ${entry.containerName} has no recorded engine target. Remove that unshipped runtime manually before managing it.`,
      ),
      { code: "INVALID_CONFIG" },
    );
  };
  const bindTarget = (target: SandboxContainerEngineTarget | undefined) =>
    target
      ? engine.id === "podman"
        ? bindPodmanSandboxEngine(target)
        : bindDockerPersistentTarget(dockerPersistentTargetFromEngineTarget(target))
      : engine;
  return {
    async describeRuntime({ entry, config, agentId }) {
      const target = resolveTarget(entry);
      await validateSandboxContainerEngineTarget(engine, target);
      const runtimeEngine = bindTarget(target);
      const state = await containerState(runtimeEngine, entry.containerName);
      let actualConfigLabel = entry.image;
      let actualImageId: string | undefined;
      if (state.exists) {
        try {
          const result = await execContainer(
            runtimeEngine,
            [
              "inspect",
              "-f",
              runtimeEngine.id === "podman" ? "{{.ImageName}}\t{{.Image}}" : "{{.Config.Image}}",
              entry.containerName,
            ],
            { allowFailure: true },
          );
          if (result.code === 0) {
            const inspected = result.stdout.trim();
            if (runtimeEngine.id === "podman") {
              const [imageName, imageId] = inspected.split("\t", 2);
              actualConfigLabel = imageName || actualConfigLabel;
              actualImageId = imageId;
            } else {
              actualConfigLabel = inspected || actualConfigLabel;
            }
          }
        } catch {
          // ignore inspect failures
        }
      }
      const sandboxCfg = resolveSandboxConfigForAgent(config, agentId);
      const configuredImage =
        entry.configLabelKind === "BrowserImage"
          ? sandboxCfg.browser.image
          : sandboxCfg.docker.image;
      let configLabelMatch = actualConfigLabel === configuredImage;
      if (runtimeEngine.id === "podman" && !configLabelMatch && actualImageId) {
        try {
          const result = await execContainer(
            runtimeEngine,
            ["image", "inspect", "-f", "{{.Id}}", configuredImage],
            { allowFailure: true },
          );
          if (result.code === 0) {
            const normalizeImageId = (value: string) => value.trim().replace(/^sha256:/u, "");
            configLabelMatch = normalizeImageId(actualImageId) === normalizeImageId(result.stdout);
          }
        } catch {
          // Keep the name comparison result when image inspection fails.
        }
      }
      return {
        running: state.running,
        actualConfigLabel,
        configLabelMatch,
      };
    },
    async removeRuntime({ entry }) {
      const target = resolveTarget(entry);
      await validateSandboxContainerEngineTarget(engine, target);
      const runtimeEngine = bindTarget(target);
      await removeSandboxContainerRuntime(runtimeEngine, entry.containerName);
    },
  };
}

export const dockerSandboxBackendManager =
  createContainerSandboxBackendManager(DOCKER_SANDBOX_ENGINE);
export const podmanSandboxBackendManager =
  createContainerSandboxBackendManager(PODMAN_SANDBOX_ENGINE);
