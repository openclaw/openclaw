/** Read-only inspection of engine-owned container identities, state, labels and ports. */
import { get, type IncomingMessage } from "node:http";
import { text } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  type SandboxContainerEngine,
} from "./container-engine.js";
import { parseInspectedSandboxMounts } from "./docker-mount-source.js";

function isStoppedContainerState(state: unknown): boolean {
  return isRecord(state) && state.Running === false && state.Paused === false && state.Pid === 0;
}

/** Check for a stopped sandbox without changing its Docker target. */
export async function dockerSandboxIsStopped(
  engine: SandboxContainerEngine,
  id: string,
  signal: AbortSignal,
  endpoint?: string,
): Promise<boolean> {
  if (!endpoint) {
    const result = await execContainer(engine, ["inspect", "-f", "{{json .State}}", id], {
      signal,
    });
    return isStoppedContainerState(JSON.parse(result.stdout));
  }
  // The captured Unix endpoint lets the warm path use Docker's inspect API directly.
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(
      {
        socketPath: endpoint.slice("unix://".length),
        path: `/containers/${id}/json`,
        signal,
        agent: false,
      },
      resolve,
    ).once("error", reject);
  });
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`Docker could not inspect sandbox ${id} (HTTP ${response.statusCode}).`);
  }
  const inspected: unknown = JSON.parse(await text(response));
  if (!isRecord(inspected) || !isRecord(inspected.State)) {
    throw new Error("Docker inspect did not return sandbox state.");
  }
  return isStoppedContainerState(inspected.State);
}

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
  return isStoppedContainerState(state);
}

export async function readDockerContainerLabel(
  containerName: string,
  label: string,
): Promise<string | null> {
  return await readContainerLabel(DOCKER_SANDBOX_ENGINE, containerName, label);
}

async function readContainerLabel(
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
  options: { strict?: boolean; includePaused?: boolean } = {},
) {
  // .ID keeps Docker's typed template path; raw JSON can omit an empty Tmpfs field.
  const result = await execContainer(
    engine,
    [
      "inspect",
      "-f",
      '{"Id":{{json .ID}},"State":{{json .State}},"Labels":{{json .Config.Labels}},"ReadonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}',
      name,
    ],
    { allowFailure: true },
  );
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
    return { exists: false as const, running: false };
  }
  const data: unknown = JSON.parse(result.stdout);
  if (!isRecord(data) || typeof data.Id !== "string" || !/^[a-f0-9]{64}$/u.test(data.Id)) {
    throw new Error("Container inspect did not return an immutable container ID.");
  }
  if (
    !isRecord(data.State) ||
    typeof data.State.Running !== "boolean" ||
    typeof data.State.Paused !== "boolean"
  ) {
    throw new Error("Container inspect did not return runtime state.");
  }
  const configHash = isRecord(data.Labels) ? data.Labels["openclaw.configHash"] : null;
  return {
    exists: true as const,
    running: data.State.Running,
    ...(options.includePaused ? { paused: data.State.Paused } : {}),
    id: data.Id,
    readOnlyRoot: data.ReadonlyRootfs === true,
    configHash: typeof configHash === "string" && configHash ? configHash : null,
    mounts: parseInspectedSandboxMounts(data.Mounts, data.Tmpfs),
  };
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
    return { exists: true };
  }
  if (isPodmanContainerNotFound(result.stderr)) {
    return { exists: false };
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
