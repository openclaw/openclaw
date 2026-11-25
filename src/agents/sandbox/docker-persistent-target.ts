import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
} from "./container-engine.js";
import {
  parseDockerPersistentExecTarget,
  type DockerPersistentExecTarget,
} from "./persistent-exec.types.js";

/** The existing registry provider envelope retains the daemon after stream custody ends. */
export function dockerPersistentTargetToEngineTarget(
  target: DockerPersistentExecTarget,
): SandboxContainerEngineTarget {
  const parsed = parseDockerPersistentExecTarget(target);
  return { key: `docker:${parsed.daemonId}`, globalArgs: ["--host", parsed.endpoint] };
}

export function dockerPersistentTargetFromEngineTarget(
  target: SandboxContainerEngineTarget,
): DockerPersistentExecTarget {
  if (
    !target.key.startsWith("docker:") ||
    target.globalArgs.length !== 2 ||
    target.globalArgs[0] !== "--host"
  ) {
    throw new Error(
      "Recorded Docker sandbox target is invalid; restore its original daemon before cleanup.",
    );
  }
  return parseDockerPersistentExecTarget({
    kind: "docker",
    daemonId: target.key.slice(7),
    endpoint: target.globalArgs[1],
  });
}

export function bindDockerPersistentTarget(
  target: DockerPersistentExecTarget,
): SandboxContainerEngine {
  const parsed = parseDockerPersistentExecTarget(target);
  const baseEnv = { ...process.env };
  for (const key of [
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]) {
    delete baseEnv[key];
  }
  return { ...DOCKER_SANDBOX_ENGINE, globalArgs: ["--host", parsed.endpoint], baseEnv };
}

/** Resolve before allocating the backend; unsupported transports retain ordinary exec only. */
export async function captureDockerPersistentTarget(): Promise<
  DockerPersistentExecTarget | undefined
> {
  using phases = observeDiagnosticsTimelinePhases("attempt.setup.sandbox.backend.docker_context");
  const signal = AbortSignal.timeout(30_000);
  const context = process.env.DOCKER_CONTEXT?.trim();
  let endpoint = context ? undefined : process.env.DOCKER_HOST?.trim();
  if (!endpoint) {
    const inspected = await execContainer(
      DOCKER_SANDBOX_ENGINE,
      [
        "context",
        "inspect",
        ...(context ? [context] : []),
        "--format",
        "{{json .Endpoints.docker}}",
      ],
      { signal },
    );
    const parsed: unknown = JSON.parse(inspected.stdout);
    if (!isRecord(parsed) || typeof parsed.Host !== "string") {
      throw new Error("Docker did not identify its current endpoint.");
    }
    endpoint = parsed.Host;
  }
  if (!endpoint.startsWith("unix:///")) {
    return undefined;
  }
  const provisional = parseDockerPersistentExecTarget({
    kind: "docker",
    endpoint,
    daemonId: "pending",
  });
  const engine = bindDockerPersistentTarget(provisional);
  phases.mark("attempt.setup.sandbox.backend.docker_daemon");
  const info = await execContainer(engine, ["info", "--format", "{{.ID}}"], { signal });
  return parseDockerPersistentExecTarget({ ...provisional, daemonId: info.stdout.trim() });
}

export async function assertDockerPersistentTargetCurrent(
  target: DockerPersistentExecTarget,
  signal?: AbortSignal,
): Promise<SandboxContainerEngine> {
  const engine = bindDockerPersistentTarget(target);
  const info = await execContainer(engine, ["info", "--format", "{{.ID}}"], { signal });
  if (info.stdout.trim() !== target.daemonId) {
    throw new Error("Original Docker daemon changed; persistent process cleanup is uncertain.");
  }
  return engine;
}

export async function readDockerPersistentContainer(
  engine: SandboxContainerEngine,
  containerId: string,
  signal?: AbortSignal,
): Promise<{ kind: "running"; startedAt: string } | { kind: "extinct" }> {
  if (!/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new Error("Persistent execution requires an immutable Docker container ID.");
  }
  const result = await execContainer(
    engine,
    ["inspect", "--format", "{{json .State}}", containerId],
    {
      allowFailure: true,
      signal,
    },
  );
  if (result.code !== 0) {
    if (
      result.stderr.includes(containerId) &&
      /no such (?:container|object)/iu.test(result.stderr)
    ) {
      return { kind: "extinct" };
    }
    throw new Error(`Original Docker container cannot be inspected: ${result.stderr.trim()}`);
  }
  const state: unknown = JSON.parse(result.stdout);
  if (!isRecord(state)) {
    throw new Error("Docker container state is unreadable; custody retained.");
  }
  if (state.Running === false && state.Paused === false && state.Pid === 0) {
    return { kind: "extinct" };
  }
  if (
    state.Running !== true ||
    state.Paused === true ||
    typeof state.StartedAt !== "string" ||
    !Number.isFinite(Date.parse(state.StartedAt))
  ) {
    throw new Error("Docker container generation is unavailable; custody retained.");
  }
  return { kind: "running", startedAt: state.StartedAt };
}
