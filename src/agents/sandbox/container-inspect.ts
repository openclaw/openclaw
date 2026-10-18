/** Read-only inspection of engine-owned container identities, state, labels and ports. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  type SandboxContainerEngine,
} from "./container-engine.js";

/** Termination proof is stricter than provisioning's best-effort existence probe. */
export async function containerHasTerminated(
  engine: SandboxContainerEngine,
  id: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const inspected = await execContainer(engine, ["inspect", "-f", "{{json .State}}", id], {
    allowFailure: true,
    signal,
  });
  if (inspected.code !== 0) {
    if (
      inspected.stderr.includes(id) &&
      /no such (?:container|object)|container .* does not exist|no container with name or id .* found/iu.test(
        inspected.stderr,
      )
    ) {
      return true;
    }
    throw new Error(`Could not verify sandbox ${id} termination: ${inspected.stderr.trim()}`);
  }
  const state: unknown = JSON.parse(inspected.stdout);
  return isRecord(state) && state.Running === false && state.Paused === false && state.Pid === 0;
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
  const result = await execContainer(
    DOCKER_SANDBOX_ENGINE,
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
  const result = await execContainer(
    DOCKER_SANDBOX_ENGINE,
    ["port", containerName, `${port}/tcp`],
    {
      allowFailure: true,
    },
  );
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

export async function dockerContainerState(name: string) {
  return await containerState(DOCKER_SANDBOX_ENGINE, name);
}

export async function containerState(
  engine: SandboxContainerEngine,
  name: string,
  options: { strict?: boolean } = {},
) {
  const result = await execContainer(engine, ["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    if (
      options.strict &&
      !/no such (?:container|object)|container .* does not exist|no container with name or id .* found/iu.test(
        result.stderr,
      )
    ) {
      throw new Error(
        `Unable to inspect ${engine.displayName} sandbox ${name}: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    return { exists: false, running: false };
  }
  return { exists: true, running: result.stdout.trim() === "true" };
}

function isPodmanContainerNotFound(stderr: string): boolean {
  // Target changes are destructive only after Podman confirms absence. Treat
  // connection and authorization failures as unknown so the old runtime stays registered.
  return (
    /no such container/iu.test(stderr) ||
    /no container with name or id .* found/iu.test(stderr) ||
    /container .* does not exist/iu.test(stderr)
  );
}

export async function recordedPodmanContainerState(engine: SandboxContainerEngine, name: string) {
  const result = await execContainer(engine, ["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return { exists: true, running: result.stdout.trim() === "true" };
  }
  if (isPodmanContainerNotFound(result.stderr)) {
    return { exists: false, running: false };
  }
  const detail = result.stderr.trim();
  throw Object.assign(
    new Error(
      detail
        ? `Unable to inspect recorded Podman sandbox runtime ${name}: ${detail}`
        : `Unable to inspect recorded Podman sandbox runtime ${name} (exit ${result.code})`,
    ),
    { code: result.code },
  );
}
