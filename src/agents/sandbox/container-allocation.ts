/** Canonical container flags, image admission, and stopped allocation for sandbox lifecycles. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { withContainerEnvFile } from "../../infra/container-env-file.js";
import { markOpenClawExecEnv } from "../../infra/openclaw-exec-env.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";
import type { SandboxMountPlan } from "./mount-plan.js";
import {
  resolvePodmanSandboxCreatePolicy,
  type PodmanSandboxRuntimeInfo,
} from "./podman-runtime.js";
import { sanitizeExplicitSandboxEnvVars } from "./sanitize-env-vars.js";
import type { SandboxConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";
import { validateSandboxSecurity } from "./validate-sandbox-security.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

const log = createSubsystemLogger("docker");

const DOCKER_DAEMON_UNAVAILABLE_MARKERS = [
  "cannot connect to the docker daemon",
  "dial unix",
  "docker daemon is not running",
  "connection refused",
];

export function isDockerDaemonUnavailable(stderr: string): boolean {
  return DOCKER_DAEMON_UNAVAILABLE_MARKERS.some((marker) => stderr.toLowerCase().includes(marker));
}

export function formatDockerDaemonUnavailableError(stderr: string): string {
  const detail = stderr.trim();
  return [
    "Sandbox mode requires Docker, but the Docker daemon is not available.",
    "Start Docker, or set `agents.defaults.sandbox.mode=off` to disable sandboxing.",
    detail ? `Docker said: ${detail}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

export async function ensureContainerImage(engine: SandboxContainerEngine, image: string) {
  const result = await execContainer(engine, ["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return;
  }
  const stderr = result.stderr.trim();
  const imageMissing =
    engine.id === "docker"
      ? stderr.toLowerCase().includes("no such image")
      : /no such image|image not known|image .* not found/iu.test(stderr);
  if (!imageMissing) {
    if (engine.id === "docker" && isDockerDaemonUnavailable(stderr)) {
      throw new Error(formatDockerDaemonUnavailableError(stderr));
    }
    if (engine.id === "docker") {
      throw new Error(`Failed to inspect sandbox image: ${stderr}`);
    }
    throw new Error(`Failed to inspect sandbox image with ${engine.displayName}: ${stderr}`);
  }
  const missingImage =
    engine.id === "docker"
      ? `Sandbox image not found: ${image}.`
      : `Sandbox image not found in ${engine.displayName}: ${image}.`;
  if (image === DEFAULT_SANDBOX_IMAGE) {
    const setup =
      engine.id === "docker"
        ? "scripts/sandbox-setup.sh before enabling Docker sandboxing"
        : `podman build -t ${image} -f scripts/docker/sandbox/Dockerfile . before enabling container sandboxing`;
    throw new Error(
      `${missingImage} Build it with ${setup}. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:trixie-slim.`,
    );
  }
  throw new Error(`${missingImage} Build or pull it first.`);
}

function normalizeDockerLimit(value?: string | number) {
  if (typeof value === "number") {
    return String(value);
  }
  return normalizeOptionalString(value);
}

function formatUlimitValue(
  name: string,
  value: string | number | { soft?: number; hard?: number },
) {
  if (!name.trim()) {
    return null;
  }
  if (typeof value === "number") {
    return `${name}=${Math.max(0, value)}`;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    return raw ? `${name}=${raw}` : null;
  }
  const limits = [value.soft, value.hard].filter((limit) => limit !== undefined);
  return limits.length ? `${name}=${limits.join(":")}` : null;
}

export function buildSandboxCreateArgs(params: {
  name: string;
  cfg: SandboxDockerConfig;
  scopeKey: string;
  labels?: Record<string, string>;
  configHash?: string;
  bindSourceRoots?: string[];
}) {
  // Runtime security validation: blocks dangerous bind mounts, network modes, and profiles.
  validateSandboxSecurity({
    ...params.cfg,
    allowedSourceRoots: params.bindSourceRoots,
    allowSourcesOutsideAllowedRoots: params.cfg.dangerouslyAllowExternalBindSources === true,
    allowReservedContainerTargets: params.cfg.dangerouslyAllowReservedContainerTargets === true,
  });

  const createdAtMs = Date.now();
  const args = ["create", "--name", params.name];
  // The container engine's init owns PID 1 so orphaned children from long-running
  // tool and browser workloads are reaped instead of accumulating against pidsLimit.
  args.push("--init");
  args.push("--label", "openclaw.sandbox=1");
  args.push("--label", `openclaw.sessionKey=${params.scopeKey}`);
  args.push("--label", `openclaw.createdAtMs=${createdAtMs}`);
  args.push("--label", `openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`);
  args.push("--label", `openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`);
  if (params.configHash) {
    args.push("--label", `openclaw.configHash=${params.configHash}`);
  }
  for (const [key, value] of Object.entries(params.labels ?? {})) {
    if (key && value) {
      args.push("--label", `${key}=${value}`);
    }
  }
  if (params.cfg.readOnlyRoot) {
    args.push("--read-only");
  }
  for (const entry of params.cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }
  if (params.cfg.network) {
    args.push("--network", params.cfg.network);
  }
  if (params.cfg.user) {
    args.push("--user", params.cfg.user);
  }
  const envSanitization = sanitizeExplicitSandboxEnvVars(params.cfg.env ?? {});
  if (envSanitization.blocked.length > 0) {
    log.warn(
      `Blocked invalid configured sandbox environment variables: ${envSanitization.blocked.join(", ")}`,
    );
  }
  if (envSanitization.warnings.length > 0) {
    log.warn(
      `Suspicious configured sandbox environment variables: ${envSanitization.warnings.join(", ")}`,
    );
  }
  const env = markOpenClawExecEnv(envSanitization.allowed);
  for (const cap of params.cfg.capDrop) {
    args.push("--cap-drop", cap);
  }
  args.push("--security-opt", "no-new-privileges");
  if (params.cfg.seccompProfile) {
    args.push("--security-opt", `seccomp=${params.cfg.seccompProfile}`);
  }
  if (params.cfg.apparmorProfile) {
    args.push("--security-opt", `apparmor=${params.cfg.apparmorProfile}`);
  }
  for (const entry of params.cfg.dns ?? []) {
    if (entry.trim()) {
      args.push("--dns", entry);
    }
  }
  for (const entry of params.cfg.extraHosts ?? []) {
    if (entry.trim()) {
      args.push("--add-host", entry);
    }
  }
  for (const [flag, value] of [
    ["--pids-limit", params.cfg.pidsLimit],
    ["--memory", normalizeDockerLimit(params.cfg.memory)],
    ["--memory-swap", normalizeDockerLimit(params.cfg.memorySwap)],
    ["--cpus", params.cfg.cpus],
    ["--gpus", params.cfg.gpus?.trim()],
  ] as const) {
    if (value) {
      args.push(flag, String(value));
    }
  }
  for (const [name, value] of Object.entries(params.cfg.ulimits ?? {})) {
    const formatted = formatUlimitValue(name, value);
    if (formatted) {
      args.push("--ulimit", formatted);
    }
  }
  return { argv: args, env };
}

export type SandboxContainerAllocationParams = {
  engine: SandboxContainerEngine;
  name: string;
  cfg: SandboxDockerConfig;
  dockerTmpfsSource: SandboxConfig["dockerTmpfsSource"];
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  scopeKey: string;
  configHash?: string;
  mountPlan: SandboxMountPlan;
  podmanRuntimeInfo?: PodmanSandboxRuntimeInfo;
  assertCurrent?: () => void;
};

/** Allocate stopped; the lifecycle owner records the generation before starting it. */
export async function allocateSandboxContainer(
  params: SandboxContainerAllocationParams,
): Promise<string> {
  const { engine, name, cfg, workspaceDir, scopeKey } = params;
  const podmanPolicy =
    engine.id === "podman" && params.podmanRuntimeInfo
      ? resolvePodmanSandboxCreatePolicy({
          cfg,
          dockerTmpfsSource: params.dockerTmpfsSource,
          workspaceDir,
          workspaceAccess: params.workspaceAccess,
          agentWorkspaceDir: params.agentWorkspaceDir,
          readOnlyWorkspaceSkillMounts: params.mountPlan.readOnlyWorkspaceSkillMounts,
          runtimeInfo: params.podmanRuntimeInfo,
        })
      : undefined;
  const createCfg = podmanPolicy?.cfg ?? cfg;
  await ensureContainerImage(engine, cfg.image);

  const { argv: args, env } = buildSandboxCreateArgs({
    name,
    cfg: createCfg,
    scopeKey,
    configHash: params.configHash,
    bindSourceRoots: [workspaceDir, params.agentWorkspaceDir],
  });
  if (podmanPolicy) {
    args.push(...podmanPolicy.extraCreateArgs);
  }
  args.push("--workdir", cfg.workdir);
  for (const bind of params.mountPlan.skippedBinds) {
    log.warn(
      `sandbox: skipping user bind "${bind}" — container path conflicts with a protected read-only skill mount`,
    );
  }
  for (const bind of params.mountPlan.binds) {
    args.push("-v", bind);
  }
  const created = await withContainerEnvFile(env, async (envFile) => {
    args.push("--env-file", envFile, cfg.image, "sleep", "infinity");
    params.assertCurrent?.();
    return await execContainer(engine, args);
  });
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new Error("Container creation did not return an immutable container ID.");
  }
  return containerId;
}
