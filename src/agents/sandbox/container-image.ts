/** Container image admission and Docker daemon availability diagnostics. */
import { DEFAULT_SANDBOX_IMAGE } from "./constants.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";

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
