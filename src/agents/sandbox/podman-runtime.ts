import {
  execContainer,
  PODMAN_SANDBOX_ENGINE,
  type SandboxContainerEngine,
} from "./container-engine.js";

const SANDBOX_ENGINE_PROBE_TIMEOUT_MS = 5_000;

export type PodmanSandboxRuntimeInfo = {
  machine: boolean;
  rootless: boolean;
};

async function assertSupportedPodmanConnection(): Promise<{ machine: boolean }> {
  const result = await execContainer(
    PODMAN_SANDBOX_ENGINE,
    ["system", "connection", "list", "--format", "json"],
    {
      allowFailure: true,
      signal: AbortSignal.timeout(SANDBOX_ENGINE_PROBE_TIMEOUT_MS),
    },
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`Failed to inspect the active Podman connection: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Podman returned invalid connection metadata", { cause: error });
  }
  const connections = Array.isArray(parsed)
    ? parsed.filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
      )
    : [];
  const configuredUri = process.env.CONTAINER_HOST?.trim();
  const configuredName = process.env.CONTAINER_CONNECTION?.trim();
  let selected: Record<string, unknown> | undefined;
  // Podman resolves the explicit URL/CONTAINER_HOST before named or saved destinations.
  if (configuredUri) {
    selected = connections.find((entry) => entry.URI === configuredUri);
  } else if (configuredName) {
    selected = connections.find((entry) => entry.Name === configuredName);
  } else {
    // OpenClaw supplies no Podman global connection flag, so Podman's documented
    // selection order reaches the saved default after the env overrides above.
    selected = connections.find((entry) => entry.Default === true);
  }
  const selectedUri = configuredUri || (typeof selected?.URI === "string" ? selected.URI : "");
  const unsupportedRemoteError = () =>
    Object.assign(
      new Error(
        "Podman sandboxing supports a local Podman engine or Podman Machine, but the active Podman connection is remote or could not be identified. Use the SSH sandbox backend for a remote host.",
      ),
      { code: "INVALID_CONFIG" },
    );
  if (!configuredUri && configuredName && !selected) {
    throw unsupportedRemoteError();
  }
  if (selectedUri && !selectedUri.startsWith("unix://")) {
    if (selected?.IsMachine === true) {
      return { machine: true };
    }
    throw unsupportedRemoteError();
  }
  // Podman's documented remote URL precedence ends at the local Unix socket
  // when no CLI, env, or saved service destination selects another target.
  return { machine: false };
}

export async function resolvePodmanSandboxRuntimeInfo(): Promise<PodmanSandboxRuntimeInfo> {
  const result = await execContainer(
    PODMAN_SANDBOX_ENGINE,
    ["info", "--format", "{{.Host.Security.Rootless}}\t{{.Host.ServiceIsRemote}}"],
    {
      allowFailure: true,
      signal: AbortSignal.timeout(SANDBOX_ENGINE_PROBE_TIMEOUT_MS),
    },
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`Failed to inspect Podman user namespace mode: ${detail}`);
  }
  const [rootless, serviceIsRemote] = result.stdout.trim().toLowerCase().split("\t", 2);
  let machine = false;
  if (serviceIsRemote === "true") {
    ({ machine } = await assertSupportedPodmanConnection());
  }
  return { machine, rootless: rootless === "true" };
}

export async function validateSandboxContainerEngineTarget(
  engine: SandboxContainerEngine,
): Promise<void> {
  if (engine.id === "podman") {
    // Podman resolves its active connection for every invocation. Validate once
    // at the start of each lifecycle sequence so context changes cannot reuse stale approval.
    await resolvePodmanSandboxRuntimeInfo();
  }
}
