/**
 * Low-level Docker command helpers for sandbox runtimes.
 *
 * Wraps Docker spawn, environment sanitization, container inspection, creation, and exec behavior.
 */
import os from "node:os";
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  execContainerRaw,
  type ExecContainerRawOptions,
  type ExecDockerRawResult,
  type SandboxContainerEngine,
} from "./container-engine.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import {
  resolvePodmanSandboxRuntimeInfo,
  type PodmanSandboxRuntimeInfo,
} from "./podman-runtime.js";
import {
  resolveDockerEnvPolicyEpoch,
  sanitizeExplicitSandboxEnvVars,
} from "./sanitize-env-vars.js";

export {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  execContainerRaw,
  PODMAN_SANDBOX_ENGINE,
} from "./container-engine.js";
export type { ExecDockerRawResult, SandboxContainerEngine } from "./container-engine.js";
export {
  resolvePodmanSandboxRuntimeInfo,
  validateSandboxContainerEngineTarget,
} from "./podman-runtime.js";
export type { PodmanSandboxRuntimeInfo } from "./podman-runtime.js";
export { resolveDockerEnvPolicyEpoch } from "./sanitize-env-vars.js";

type ExecDockerRawOptions = ExecContainerRawOptions;

export async function execDockerRaw(
  args: string[],
  opts?: ExecDockerRawOptions,
): Promise<ExecDockerRawResult> {
  return await execContainerRaw(DOCKER_SANDBOX_ENGINE, args, opts);
}

import { markOpenClawExecEnv } from "../../infra/openclaw-exec-env.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { handleHotSandboxConfigMismatch } from "./current-config.js";
import { readRegistryEntry, updateRegistry } from "./registry.js";
import { resolveSandboxScopeKey, slugifySessionKey } from "./shared.js";
import type { SandboxConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";
import { validateSandboxSecurity } from "./validate-sandbox-security.js";
import {
  appendReadOnlyWorkspaceSkillMountArgs,
  appendWorkspaceMountArgs,
  formatReadOnlyWorkspaceSkillMountHashState,
  resolveReadOnlyWorkspaceSkillMounts,
  SANDBOX_MOUNT_FORMAT_VERSION,
  type ReadOnlyWorkspaceSkillMount,
} from "./workspace-mounts.js";

const log = createSubsystemLogger("docker");

const HOT_CONTAINER_WINDOW_MS = 5 * 60 * 1000;
const PODMAN_INIT_PATH = "/run/podman-init";

type ExecDockerOptions = ExecDockerRawOptions;

export async function execDocker(args: string[], opts?: ExecDockerOptions) {
  const result = await execDockerRaw(args, opts);
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    code: result.code,
  };
}

export async function readDockerContainerLabel(
  containerName: string,
  label: string,
): Promise<string | null> {
  return await readContainerLabel(DOCKER_SANDBOX_ENGINE, containerName, label);
}

export async function readContainerLabel(
  engine: SandboxContainerEngine,
  containerName: string,
  label: string,
): Promise<string | null> {
  const result = await execContainer(
    engine,
    ["inspect", "-f", `{{ index .Config.Labels "${label}" }}`, containerName],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return null;
  }
  const raw = result.stdout.trim();
  if (!raw || raw === "<no value>") {
    return null;
  }
  return raw;
}

export async function readDockerContainerEnvVar(
  containerName: string,
  envVar: string,
): Promise<string | null> {
  const result = await execDocker(
    ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", containerName],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return null;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith(`${envVar}=`)) {
      return line.slice(envVar.length + 1);
    }
  }
  return null;
}

export async function readDockerPort(containerName: string, port: number) {
  const result = await execDocker(["port", containerName, `${port}/tcp`], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return null;
  }
  const line = result.stdout.trim().split(/\r?\n/)[0] ?? "";
  const match = line.match(/:(\d+)\s*$/);
  if (!match) {
    return null;
  }
  const mapped = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(mapped) ? mapped : null;
}

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

export async function ensureDockerImage(image: string) {
  await ensureContainerImage(DOCKER_SANDBOX_ENGINE, image);
}

export async function ensureContainerImage(engine: SandboxContainerEngine, image: string) {
  const imageState = await inspectContainerImage(engine, image);
  if (imageState === "exists") {
    return;
  }
  if (image === DEFAULT_SANDBOX_IMAGE) {
    if (engine.id === "docker") {
      throw new Error(
        `Sandbox image not found: ${image}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
      );
    }
    throw new Error(
      `Sandbox image not found in ${engine.displayName}: ${image}. Build it with podman build -t ${image} -f scripts/docker/sandbox/Dockerfile . before enabling container sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
    );
  }
  if (engine.id === "docker") {
    throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
  }
  throw new Error(
    `Sandbox image not found in ${engine.displayName}: ${image}. Build or pull it first.`,
  );
}

export async function dockerContainerState(name: string) {
  return await containerState(DOCKER_SANDBOX_ENGINE, name);
}

export async function containerState(engine: SandboxContainerEngine, name: string) {
  const result = await execContainer(engine, ["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return { exists: false, running: false };
  }
  return { exists: true, running: result.stdout.trim() === "true" };
}

function normalizeDockerLimit(value?: string | number) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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

export function buildSandboxCreateArgs(params: {
  name: string;
  cfg: SandboxDockerConfig;
  scopeKey: string;
  createdAtMs?: number;
  labels?: Record<string, string>;
  configHash?: string;
  includeBinds?: boolean;
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
  for (const [key, value] of Object.entries(markOpenClawExecEnv(envSanitization.allowed))) {
    args.push("--env", `${key}=${value}`);
  }
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
  if (params.includeBinds !== false && params.cfg.binds?.length) {
    for (const bind of params.cfg.binds) {
      args.push("-v", bind);
    }
  }
  return args;
}

function appendCustomBinds(args: string[], cfg: SandboxDockerConfig): void {
  if (!cfg.binds?.length) {
    return;
  }
  for (const bind of cfg.binds) {
    args.push("-v", bind);
  }
}

function mountTargetCoversPodmanInit(target: string): boolean {
  const normalizedTarget = path.posix.normalize(target.trim());
  return (
    normalizedTarget === "/" ||
    normalizedTarget === PODMAN_INIT_PATH ||
    PODMAN_INIT_PATH.startsWith(`${normalizedTarget}/`) ||
    normalizedTarget.startsWith(`${PODMAN_INIT_PATH}/`)
  );
}

function assertPodmanMachineBindSourcesSupported(params: {
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  readOnlyWorkspaceSkillMounts: readonly ReadOnlyWorkspaceSkillMount[];
}): void {
  const hostHome = resolveSandboxHostPathViaExistingAncestor(path.resolve(os.homedir()));
  const sources = new Set<string>([params.workspaceDir]);
  if (params.workspaceAccess !== "none" && params.workspaceDir !== params.agentWorkspaceDir) {
    sources.add(params.agentWorkspaceDir);
  }
  for (const mount of params.readOnlyWorkspaceSkillMounts) {
    sources.add(mount.hostPath);
  }
  for (const bind of params.cfg.binds ?? []) {
    const source = splitSandboxBindSpec(bind)?.host.trim();
    if (source) {
      sources.add(source);
    }
  }

  for (const source of sources) {
    const canonicalSource = resolveSandboxHostPathViaExistingAncestor(path.resolve(source));
    if (isPathInside(hostHome, canonicalSource)) {
      continue;
    }
    throw Object.assign(
      new Error(
        `Podman Machine sandbox bind source "${source}" is outside the default host home share "${os.homedir()}". Move the workspace or bind under the host home directory, or use Docker or the SSH sandbox backend.`,
      ),
      { code: "INVALID_CONFIG" },
    );
  }
}

async function createSandboxContainer(params: {
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
  readOnlyWorkspaceSkillMounts: readonly ReadOnlyWorkspaceSkillMount[];
  podmanRuntimeInfo?: PodmanSandboxRuntimeInfo;
}) {
  const { engine, name, cfg, workspaceDir, scopeKey } = params;
  const createCfg =
    engine.id === "podman" && params.dockerTmpfsSource === "default"
      ? {
          ...cfg,
          // The shared default includes bare /run, but Podman mounts its init there.
          // Read-only roots get Podman's native /run tmpfs below; writable roots use /run directly.
          tmpfs: cfg.tmpfs.filter((entry) => entry.trim() !== "/run"),
        }
      : cfg;
  const hasPodmanInitMountConflict =
    engine.id === "podman" &&
    // workdir is also the managed workspace bind target below, not only the process cwd.
    (mountTargetCoversPodmanInit(cfg.workdir) ||
      createCfg.tmpfs.some((entry) =>
        mountTargetCoversPodmanInit(entry.split(":", 1)[0]?.trim() || ""),
      ) ||
      cfg.binds?.some((bind) => {
        const target = splitSandboxBindSpec(bind)?.container.trim();
        return target ? mountTargetCoversPodmanInit(target) : false;
      }) === true);
  if (hasPodmanInitMountConflict) {
    throw Object.assign(
      new Error(
        "Podman sandbox configuration would cover Podman's init path at /run/podman-init. Remove the conflicting tmpfs or bind mount so orphaned sandbox processes can be reaped.",
      ),
      { code: "INVALID_CONFIG" },
    );
  }
  if (params.podmanRuntimeInfo?.machine) {
    assertPodmanMachineBindSourcesSupported(params);
  }
  await ensureContainerImage(engine, cfg.image);

  const args = buildSandboxCreateArgs({
    name,
    cfg: createCfg,
    scopeKey,
    configHash: params.configHash,
    includeBinds: false,
    bindSourceRoots: [workspaceDir, params.agentWorkspaceDir],
  });
  if (engine.id === "podman") {
    // Podman otherwise imports host proxy variables independently of the explicit sandbox env.
    args.push("--http-proxy=false");
    if (cfg.readOnlyRoot) {
      args.push("--read-only-tmpfs=true");
    }
    if (!cfg.user) {
      // Resolve against the engine host so native remote contexts and Podman machines use
      // their own identity. Bound rootless mappings so long-lived sandboxes do not consume
      // every subordinate ID and block unrelated `--userns=auto` workloads.
      args.push("--userns", "keep-id");
    }
  }
  args.push("--workdir", cfg.workdir);
  appendWorkspaceMountArgs({
    args,
    workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir: cfg.workdir,
    workspaceAccess: params.workspaceAccess,
    readOnlyWorkspaceSkillMounts: params.readOnlyWorkspaceSkillMounts,
    includeReadOnlyWorkspaceSkillMounts: false,
  });
  appendCustomBinds(args, cfg);
  appendReadOnlyWorkspaceSkillMountArgs({
    args,
    readOnlyWorkspaceSkillMounts: params.readOnlyWorkspaceSkillMounts,
  });
  args.push(cfg.image, "sleep", "infinity");

  await execContainer(engine, args);
  await execContainer(engine, ["start", name]);

  if (cfg.setupCommand?.trim()) {
    await execContainer(engine, ["exec", "-i", name, "/bin/sh", "-lc", cfg.setupCommand]);
  }
}

async function readContainerConfigHash(
  engine: SandboxContainerEngine,
  containerName: string,
): Promise<string | null> {
  return await readContainerLabel(engine, containerName, "openclaw.configHash");
}

export async function ensureSandboxContainer(params: {
  engine?: SandboxContainerEngine;
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  cfg: SandboxConfig;
  requireCurrentConfig?: boolean;
}) {
  const engine = params.engine ?? DOCKER_SANDBOX_ENGINE;
  const podmanRuntimeInfo =
    engine.id === "podman" ? await resolvePodmanSandboxRuntimeInfo() : undefined;
  const scopeKey = resolveSandboxScopeKey(params.cfg.scope, params.sessionKey);
  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
  const containerName =
    engine.id === "docker"
      ? `${params.cfg.docker.containerPrefix}${slug}`.slice(0, 63)
      : (() => {
          // Preserve the hashed scope slug for Podman's engine marker; truncating the
          // tail would collapse separate sessions onto one mounted workspace.
          const engineMarker = "podman-";
          const prefixLimit = Math.max(0, 63 - engineMarker.length - slug.length);
          return `${params.cfg.docker.containerPrefix.slice(0, prefixLimit)}${engineMarker}${slug}`;
        })();
  const readOnlyWorkspaceSkillMounts = resolveReadOnlyWorkspaceSkillMounts({
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir: params.cfg.docker.workdir,
    workspaceAccess: params.cfg.workspaceAccess,
  });
  const genericConfigHash = computeSandboxConfigHash({
    docker: params.cfg.docker,
    dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(params.cfg.docker.env),
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    readOnlyWorkspaceSkillMounts: formatReadOnlyWorkspaceSkillMountHashState(
      readOnlyWorkspaceSkillMounts,
    ),
  });
  const podmanUserMode = params.cfg.docker.user ? "configured-user" : "keep-id";
  const expectedHash =
    engine.id === "podman"
      ? `${genericConfigHash}:podman-runtime-v5:${podmanUserMode}:${params.cfg.dockerTmpfsSource}`
      : genericConfigHash;
  const now = Date.now();
  const state = await containerState(engine, containerName);
  let hasContainer = state.exists;
  let running = state.running;
  let currentHash: string | null = null;
  let hashMismatch = false;
  let registryEntry:
    | {
        lastUsedAtMs: number;
        configHash?: string;
      }
    | undefined;
  if (hasContainer) {
    registryEntry = (await readRegistryEntry(containerName)) ?? undefined;
    currentHash = await readContainerConfigHash(engine, containerName);
    if (!currentHash) {
      currentHash = registryEntry?.configHash ?? null;
    }
    hashMismatch = !currentHash || currentHash !== expectedHash;
    if (hashMismatch) {
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      const isHot =
        running &&
        (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_CONTAINER_WINDOW_MS);
      if (isHot) {
        handleHotSandboxConfigMismatch({
          containerName,
          scope: params.cfg.scope,
          sessionKey: scopeKey,
          ...(params.requireCurrentConfig !== undefined
            ? { requireCurrentConfig: params.requireCurrentConfig }
            : {}),
        });
      } else {
        await execContainer(engine, ["rm", "-f", containerName], { allowFailure: true });
        hasContainer = false;
        running = false;
      }
    }
  }
  if (!hasContainer) {
    await createSandboxContainer({
      engine,
      name: containerName,
      cfg: params.cfg.docker,
      dockerTmpfsSource: params.cfg.dockerTmpfsSource,
      workspaceDir: params.workspaceDir,
      workspaceAccess: params.cfg.workspaceAccess,
      agentWorkspaceDir: params.agentWorkspaceDir,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      scopeKey,
      configHash: expectedHash,
      readOnlyWorkspaceSkillMounts,
      podmanRuntimeInfo,
    });
  } else if (!running) {
    await execContainer(engine, ["start", containerName]);
  }
  await updateRegistry({
    containerName,
    backendId: engine.id,
    runtimeLabel: containerName,
    sessionKey: scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.docker.image,
    configLabelKind: "Image",
    configHash: hashMismatch && running ? (currentHash ?? undefined) : expectedHash,
  });
  return containerName;
}
