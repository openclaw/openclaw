/** Read-only inspection of engine-owned container identities, state, labels and ports. */
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  type SandboxContainerEngine,
} from "./container-engine.js";

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

export async function containerState(engine: SandboxContainerEngine, name: string) {
  const result = await execContainer(engine, ["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return { exists: false, running: false };
  }
  return { exists: true, running: result.stdout.trim() === "true" };
}
