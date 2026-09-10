/**
 * Docker sandbox backend implementation.
 *
 * Creates/reuses Docker containers and exposes backend-neutral exec and shell-command handles.
 */
import { randomUUID } from "node:crypto";
import { createContainerEnvFile } from "../../infra/container-env-file.js";
import { toErrorObject } from "../../infra/errors.js";
import type { SandboxBackendCommandParams } from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  containerState,
  bindPodmanSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  ensureSandboxContainer,
  execContainer,
  execContainerRaw,
  PODMAN_SANDBOX_ENGINE,
  resolvePodmanSandboxRuntimeInfo,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
  validateSandboxContainerEngineTarget,
} from "./docker.js";
import { removeRegistryEntry, type SandboxRegistryEntry } from "./registry.js";

type ContainerExecFinalizeToken = () => Promise<void>;

function resolveContainerExecEnv(env: Record<string, string>): Record<string, string> {
  const { PATH: requestedPath, ...containerEnv } = env;
  if (requestedPath) {
    containerEnv.OPENCLAW_PREPEND_PATH = requestedPath;
  }
  return containerEnv;
}

function buildContainerExecArgs(params: {
  containerName: string;
  command: string;
  workdir?: string;
  env: Record<string, string>;
  envFile: string;
  tty: boolean;
}): string[] {
  const args = ["exec", "-i"];
  if (params.tty) {
    args.push("-t");
  }
  if (params.workdir) {
    args.push("-w", params.workdir);
  }
  args.push("--env-file", params.envFile);
  // Apply the staged prepend only after login profile sourcing; direct PATH
  // injection can break the container engine's initial executable lookup.
  const pathExport = params.env.PATH
    ? 'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; '
    : "";
  // Use absolute path for sh to avoid dependency on PATH resolution during exec.
  args.push(params.containerName, "/bin/sh", "-lc", `${pathExport}${params.command}`);
  return args;
}

function resolveConfiguredDockerRuntimeImage(params: {
  config: CreateSandboxBackendParams["cfg"] | import("../../config/config.js").OpenClawConfig;
  agentId?: string;
  configLabelKind?: string;
}): string {
  const sandboxCfg = resolveSandboxConfigForAgent(params.config, params.agentId);
  switch (params.configLabelKind) {
    case "BrowserImage":
      return sandboxCfg.browser.image;
    default:
      return sandboxCfg.docker.image;
  }
}

async function createContainerSandboxBackend(
  engine: SandboxContainerEngine,
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  if (engine.id === "podman" && params.cfg.browser.enabled) {
    throw new Error(
      "Podman sandboxing does not support browser sandboxes. Install Docker and select the docker backend, or disable sandbox.browser.enabled.",
    );
  }
  const podmanTarget =
    engine.id === "podman" ? (await resolvePodmanSandboxRuntimeInfo()).target : undefined;
  const boundEngine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : engine;
  const containerName = await ensureSandboxContainer({
    engine: boundEngine,
    ...(podmanTarget ? { podmanTarget } : {}),
    scopeKey: params.scopeKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    cfg: params.cfg,
    internalMounts: params.internalMounts,
    ...(params.requireCurrentConfig !== undefined
      ? { requireCurrentConfig: params.requireCurrentConfig }
      : {}),
  });
  return createContainerSandboxBackendHandle({
    engine: boundEngine,
    containerName,
    workdir: params.cfg.docker.workdir,
    env: params.cfg.docker.env,
    image: params.cfg.docker.image,
    podmanTarget,
  });
}

export async function createDockerSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  return await createContainerSandboxBackend(DOCKER_SANDBOX_ENGINE, params);
}

export async function createPodmanSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  return await createContainerSandboxBackend(PODMAN_SANDBOX_ENGINE, params);
}

function createContainerSandboxBackendHandle(params: {
  engine: SandboxContainerEngine;
  containerName: string;
  workdir: string;
  env?: Record<string, string>;
  image: string;
  podmanTarget?: SandboxContainerEngineTarget;
}): SandboxBackendHandle {
  return {
    id: params.engine.id,
    runtimeId: params.containerName,
    runtimeLabel: params.containerName,
    workdir: params.workdir,
    env: params.env,
    configLabel: params.image,
    configLabelKind: "Image",
    capabilities: {
      browser: params.engine.id === "docker",
    },
    async buildExecSpec({ command, workdir, env, usePty }) {
      await validateSandboxContainerEngineTarget(params.engine, params.podmanTarget);
      const envFile = await createContainerEnvFile(resolveContainerExecEnv(env));
      try {
        const argv = [
          params.engine.command,
          ...(params.engine.globalArgs ?? []),
          ...buildContainerExecArgs({
            containerName: params.containerName,
            command,
            workdir: workdir ?? params.workdir,
            env,
            envFile: envFile.path,
            tty: usePty,
          }),
        ];
        return {
          argv,
          env: process.env,
          stdinMode: usePty ? "pipe-open" : "pipe-closed",
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
    runShellCommand(command) {
      return runContainerSandboxShellCommand({
        engine: params.engine,
        containerName: params.containerName,
        podmanTarget: params.podmanTarget,
        ...command,
      });
    },
    async disposeRuntime() {
      await validateSandboxContainerEngineTarget(params.engine, params.podmanTarget);
      const result = await execContainer(params.engine, ["rm", "-f", params.containerName], {
        allowFailure: true,
      });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        if (!/No such (container|object)|does not exist/iu.test(detail)) {
          throw new Error(
            `Failed to dispose ${params.engine.displayName} sandbox runtime ${params.containerName}: ${detail}`,
          );
        }
      }
      await removeRegistryEntry(params.containerName);
    },
  };
}

async function runContainerSandboxShellCommand(
  params: {
    engine: SandboxContainerEngine;
    containerName: string;
    podmanTarget?: SandboxContainerEngineTarget;
  } & SandboxBackendCommandParams,
) {
  await validateSandboxContainerEngineTarget(params.engine, params.podmanTarget);
  const envFile = params.env ? await createContainerEnvFile(params.env) : undefined;
  const controlPath = params.terminateOnAbort
    ? `/tmp/openclaw-command-${randomUUID()}.pid`
    : undefined;
  const cancelPath = controlPath ? `${controlPath}.cancel` : undefined;
  const wrapper = controlPath
    ? 'control="$1"; cancel="$2"; script="$3"; shift 3; [ ! -e "$cancel" ] || exit 130; setsid sh -c \'control="$1"; cancel="$2"; script="$3"; shift 3; echo "$$" > "$control"; [ ! -e "$cancel" ] || exit 130; exec sh -c "$script" openclaw-sandbox-fs "$@"\' openclaw-sandbox-group "$control" "$cancel" "$script" "$@"; code=$?; rm -f -- "$control" "$cancel"; exit "$code"'
    : params.script;
  const dockerArgs = [
    "exec",
    "-i",
    ...(envFile ? ["--env-file", envFile.path] : []),
    params.containerName,
    "sh",
    "-c",
    wrapper,
    "openclaw-sandbox-fs",
  ];
  if (controlPath) {
    dockerArgs.push(controlPath, cancelPath!, params.script);
  }
  if (params.args?.length) {
    dockerArgs.push(...params.args);
  }
  try {
    if (!controlPath || !params.signal) {
      return await execContainerRaw(params.engine, dockerArgs, {
        input: params.stdin,
        allowFailure: params.allowFailure,
        signal: params.signal,
      });
    }
    params.signal.throwIfAborted();
    const clientAbort = new AbortController();
    const execution = execContainerRaw(params.engine, dockerArgs, {
      input: params.stdin,
      allowFailure: params.allowFailure,
      signal: clientAbort.signal,
    });
    const aborted = new Promise<"aborted">((resolve) => {
      if (params.signal?.aborted) {
        resolve("aborted");
      } else {
        params.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
      }
    });
    const outcome = await Promise.race([
      execution.then((result) => ({ result })),
      aborted.then(() => ({ aborted: true as const })),
    ]);
    if ("result" in outcome) {
      return outcome.result;
    }
    let terminationError: unknown;
    try {
      await terminateContainerCommand({
        engine: params.engine,
        containerName: params.containerName,
        controlPath,
        cancelPath: cancelPath!,
      });
    } catch (error) {
      terminationError = error;
    }
    if (!terminationError) {
      clientAbort.abort();
    }
    await execution.catch(() => undefined);
    if (terminationError) {
      throw toErrorObject(terminationError, "Failed to terminate sandbox command");
    }
    throw params.signal.reason instanceof Error ? params.signal.reason : new Error("Aborted");
  } finally {
    await envFile?.cleanup();
  }
}

async function terminateContainerCommand(params: {
  engine: SandboxContainerEngine;
  containerName: string;
  controlPath: string;
  cancelPath: string;
}): Promise<void> {
  const script =
    'control="$1"; cancel="$2"; : > "$cancel"; i=0; while [ ! -s "$control" ] && [ "$i" -lt 50 ]; do sleep 0.02; i=$((i + 1)); done; [ -s "$control" ] || exit 0; pid=$(cat "$control"); kill -TERM -- "-$pid" 2>/dev/null || true; i=0; while kill -0 -- "-$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.02; i=$((i + 1)); done; kill -KILL -- "-$pid" 2>/dev/null || true; while kill -0 -- "-$pid" 2>/dev/null; do sleep 0.02; done';
  const result = await execContainerRaw(
    params.engine,
    [
      "exec",
      params.containerName,
      "sh",
      "-c",
      script,
      "openclaw-sandbox-kill",
      params.controlPath,
      params.cancelPath,
    ],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    throw new Error(
      `Failed to terminate sandbox command process group (exit ${result.code}): ${result.stderr.toString("utf8").trim()}`,
    );
  }
}

export function runDockerSandboxShellCommand(
  params: {
    containerName: string;
  } & SandboxBackendCommandParams,
) {
  return runContainerSandboxShellCommand({
    engine: DOCKER_SANDBOX_ENGINE,
    ...params,
  });
}

function createContainerSandboxBackendManager(
  engine: SandboxContainerEngine,
): SandboxBackendManager {
  const resolvePodmanTarget = (entry: SandboxRegistryEntry) => {
    if (engine.id !== "podman") {
      return undefined;
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
  return {
    async describeRuntime({ entry, config, agentId }) {
      const podmanTarget = resolvePodmanTarget(entry);
      await validateSandboxContainerEngineTarget(engine, podmanTarget);
      const runtimeEngine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : engine;
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
      const configuredImage = resolveConfiguredDockerRuntimeImage({
        config,
        agentId,
        configLabelKind: entry.configLabelKind,
      });
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
      const podmanTarget = resolvePodmanTarget(entry);
      await validateSandboxContainerEngineTarget(engine, podmanTarget);
      const runtimeEngine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : engine;
      const result = await execContainer(runtimeEngine, ["rm", "-f", entry.containerName], {
        allowFailure: true,
      });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        if (/No such (container|object)|does not exist/iu.test(detail)) {
          return;
        }
        throw new Error(
          `Failed to remove ${engine.displayName} sandbox runtime ${entry.containerName}: ${detail}`,
        );
      }
    },
  };
}

export const dockerSandboxBackendManager =
  createContainerSandboxBackendManager(DOCKER_SANDBOX_ENGINE);
export const podmanSandboxBackendManager =
  createContainerSandboxBackendManager(PODMAN_SANDBOX_ENGINE);
