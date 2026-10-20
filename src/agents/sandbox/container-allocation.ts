/** Canonical container flags, image admission, and stopped allocation for sandbox lifecycles. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { withContainerEnvFile } from "../../infra/container-env-file.js";
import { markOpenClawExecEnv } from "../../infra/openclaw-exec-env.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";
import type { SandboxMountPlan } from "./mount-plan.js";
import type { SandboxPersistentExecCommand } from "./persistent-exec.types.js";
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

async function inspectContainerImage(
  engine: SandboxContainerEngine,
  image: string,
): Promise<"exists" | "missing"> {
  const result = await execContainer(engine, ["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return "exists";
  }
  const stderr = result.stderr.trim();
  const imageMissing =
    engine.id === "docker"
      ? stderr.toLowerCase().includes("no such image")
      : /no such image|image not known|image .* not found/iu.test(stderr);
  if (imageMissing) {
    return "missing";
  }
  if (engine.id === "docker" && isDockerDaemonUnavailable(stderr)) {
    throw new Error(formatDockerDaemonUnavailableError(stderr));
  }
  if (engine.id === "docker") {
    throw new Error(`Failed to inspect sandbox image: ${stderr}`);
  }
  throw new Error(`Failed to inspect sandbox image with ${engine.displayName}: ${stderr}`);
}

export async function ensureContainerImage(engine: SandboxContainerEngine, image: string) {
  const imageState = await inspectContainerImage(engine, image);
  if (imageState === "exists") {
    return;
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
    return Number.isFinite(value) ? String(value) : undefined;
  }
  return normalizeOptionalString(value);
}

function normalizeFiniteDockerNumber(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, value) : undefined;
}

function formatUlimitValue(
  name: string,
  value: string | number | { soft?: number; hard?: number },
) {
  if (!name.trim()) {
    return null;
  }
  if (typeof value === "number") {
    const normalized = normalizeFiniteDockerNumber(value, 0);
    return normalized === undefined ? null : `${name}=${normalized}`;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    return raw ? `${name}=${raw}` : null;
  }
  const soft = normalizeFiniteDockerNumber(value.soft, 0);
  const hard = normalizeFiniteDockerNumber(value.hard, 0);
  const limits = [soft, hard].filter((limit) => limit !== undefined);
  return limits.length ? `${name}=${limits.join(":")}` : null;
}

export function buildSandboxCreateArgs(params: {
  name: string;
  cfg: SandboxDockerConfig;
  scopeKey: string;
  createdAtMs?: number;
  labels?: Record<string, string>;
  configHash?: string;
  bindSourceRoots?: string[];
  allowSourcesOutsideAllowedRoots?: boolean;
  allowReservedContainerTargets?: boolean;
  allowContainerNamespaceJoin?: boolean;
}) {
  // Runtime security validation: blocks dangerous bind mounts, network modes, and profiles.
  validateSandboxSecurity({
    ...params.cfg,
    allowedSourceRoots: params.bindSourceRoots,
    allowSourcesOutsideAllowedRoots:
      params.allowSourcesOutsideAllowedRoots ??
      params.cfg.dangerouslyAllowExternalBindSources === true,
    allowReservedContainerTargets:
      params.allowReservedContainerTargets ??
      params.cfg.dangerouslyAllowReservedContainerTargets === true,
    dangerouslyAllowContainerNamespaceJoin:
      params.allowContainerNamespaceJoin ??
      params.cfg.dangerouslyAllowContainerNamespaceJoin === true,
  });

  const createdAtMs = params.createdAtMs ?? Date.now();
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
  const pidsLimit = normalizeFiniteDockerNumber(params.cfg.pidsLimit, 0);
  if (pidsLimit !== undefined && pidsLimit > 0) {
    args.push("--pids-limit", String(pidsLimit));
  }
  const memory = normalizeDockerLimit(params.cfg.memory);
  if (memory) {
    args.push("--memory", memory);
  }
  const memorySwap = normalizeDockerLimit(params.cfg.memorySwap);
  if (memorySwap) {
    args.push("--memory-swap", memorySwap);
  }
  const cpus = normalizeFiniteDockerNumber(params.cfg.cpus, 0);
  if (cpus !== undefined && cpus > 0) {
    args.push("--cpus", String(cpus));
  }
  const gpus = params.cfg.gpus?.trim();
  if (gpus) {
    args.push("--gpus", gpus);
  }
  for (const [name, value] of Object.entries(params.cfg.ulimits ?? {})) {
    const formatted = formatUlimitValue(name, value);
    if (formatted) {
      args.push("--ulimit", formatted);
    }
  }
  return { argv: args, env };
}

function appendCustomBinds(args: string[], binds: readonly string[] | undefined): void {
  for (const bind of binds ?? []) {
    args.push("-v", bind);
  }
}

export type SandboxContainerAllocationParams = {
  engine: SandboxContainerEngine;
  name: string;
  cfg: SandboxDockerConfig;
  dockerTmpfsSource: SandboxConfig["dockerTmpfsSource"];
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  scopeKey: string;
  configHash?: string;
  mountPlan: SandboxMountPlan;
  podmanRuntimeInfo?: PodmanSandboxRuntimeInfo;
  assertCurrent?: () => void;
  labels?: Record<string, string>;
  command?: SandboxPersistentExecCommand;
};

/** Allocate inertly; the caller records custody before starting any container process. */
export async function allocateSandboxContainer(
  params: SandboxContainerAllocationParams,
): Promise<string> {
  const { engine, name, workspaceDir, scopeKey } = params;
  const cfg = params.command?.env
    ? { ...params.cfg, env: { ...params.cfg.env, ...params.command.env } }
    : params.cfg;
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
    labels: params.labels,
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
  appendCustomBinds(args, params.mountPlan.binds);
  const command = params.command
    ? [
        "-c",
        [
          "set -e",
          "setup_command=$1; workload_cwd=$2; shift 2",
          'if [ -n "$setup_command" ]; then /bin/sh -lc "$setup_command" >&2; fi',
          'cd -- "$workload_cwd"',
          'exec "$@"',
        ].join("\n"),
        "openclaw-sandbox-stream",
        cfg.setupCommand?.trim() ? cfg.setupCommand : "",
        params.command.cwd ?? cfg.workdir,
        ...params.command.argv,
      ]
    : ["sleep", "infinity"];
  if (params.command) {
    // A stream executes its approved argv, independent of an image's entrypoint.
    args.push("--entrypoint", "/bin/sh", "--log-driver", "none");
  }
  const created = await withContainerEnvFile(env, async (envFile) => {
    args.push("--env-file", envFile, cfg.image, ...command);
    params.assertCurrent?.();
    return await execContainer(engine, args);
  });
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new Error("Container creation did not return an immutable container ID.");
  }
  return containerId;
}
