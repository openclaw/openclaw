import { randomBytes } from "node:crypto";
import type { DeviceCredentials } from "../db/queries.js";
import { generateDeviceIdentity, buildPairedDevicesJson } from "../gateway/device-auth.js";

type SpawnResult = {
  containerId: string;
  gatewayUrl: string;
  gatewayToken: string;
  bridgeUrl: string;
  deviceCredentials: DeviceCredentials;
};

let Docker: typeof import("dockerode") | null = null;

async function getDocker(): Promise<InstanceType<typeof import("dockerode")>> {
  if (!Docker) {
    try {
      Docker = (await import("dockerode")).default;
    } catch {
      throw new Error("Docker is not available — dockerode module not installed");
    }
  }
  return new Docker();
}

// Forward LLM provider keys from the hub's env to spawned containers
function getPassthroughEnv(): string[] {
  const keys = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "CLAUDE_AI_SESSION_KEY",
    "CLAUDE_WEB_SESSION_KEY",
    "CLAUDE_WEB_COOKIE",
  ];
  const env: string[] = [];
  for (const key of keys) {
    const val = process.env[key];
    if (val) {
      env.push(`${key}=${val}`);
    }
  }
  return env;
}

export async function spawnInstance(params: { name: string; image: string }): Promise<SpawnResult> {
  const docker = await getDocker();

  const gatewayToken = randomBytes(32).toString("hex");
  const device = generateDeviceIdentity();

  // Build bootstrap files: config + pre-paired device
  const configJson = JSON.stringify({
    gateway: {
      mode: "local",
      controlUi: {
        allowInsecureAuth: true,
        dangerouslyDisableDeviceAuth: true,
      },
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.2" },
      },
    },
  });
  const pairedJson = buildPairedDevicesJson(device);

  const container = await docker.createContainer({
    Image: params.image,
    name: `openclaw-${params.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    Env: [
      "HOME=/home/node",
      "TERM=xterm-256color",
      `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
      ...getPassthroughEnv(),
    ],
    Cmd: [
      "sh",
      "-c",
      // Bootstrap config + pre-paired device identity only on first run,
      // then start gateway.  Subsequent restarts (e.g. after config.patch
      // adds Slack credentials) must NOT overwrite the patched config.
      `mkdir -p /home/node/.openclaw/devices` +
        ` && [ -f /home/node/.openclaw/openclaw.json ] || printf '%s' '${configJson}' > /home/node/.openclaw/openclaw.json` +
        ` && [ -f /home/node/.openclaw/devices/paired.json ] || printf '%s' '${pairedJson}' > /home/node/.openclaw/devices/paired.json` +
        ` && exec node dist/index.js gateway --bind lan --port 18789`,
    ],
    ExposedPorts: {
      "18789/tcp": {},
      "18790/tcp": {},
    },
    HostConfig: {
      PublishAllPorts: true,
      Init: true,
      RestartPolicy: { Name: "unless-stopped" },
    },
  });

  await container.start();

  // Inspect to discover assigned host ports
  const info = await container.inspect();
  const ports = info.NetworkSettings.Ports;

  const gatewayPort = ports["18789/tcp"]?.[0]?.HostPort;
  const bridgePort = ports["18790/tcp"]?.[0]?.HostPort;

  if (!gatewayPort || !bridgePort) {
    // Cleanup on failure
    try {
      await container.stop();
      await container.remove();
    } catch {
      /* best effort */
    }
    throw new Error("Failed to discover container ports");
  }

  return {
    containerId: info.Id,
    gatewayUrl: `ws://localhost:${gatewayPort}`,
    gatewayToken,
    bridgeUrl: `http://localhost:${bridgePort}`,
    deviceCredentials: {
      deviceId: device.deviceId,
      publicKeyPem: device.publicKeyPem,
      privateKeyPem: device.privateKeyPem,
      publicKeyBase64Url: device.publicKeyBase64Url,
    },
  };
}

export async function stopInstance(containerId: string): Promise<void> {
  const docker = await getDocker();
  const container = docker.getContainer(containerId);
  await container.stop();
}

export async function startInstance(containerId: string): Promise<void> {
  const docker = await getDocker();
  const container = docker.getContainer(containerId);
  await container.start();
}

export async function getContainerLogs(containerId: string, tail = 200): Promise<string> {
  const docker = await getDocker();
  const container = docker.getContainer(containerId);
  const logs = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  });
  // dockerode returns a Buffer; strip docker stream header bytes (8-byte prefix per frame)
  return typeof logs === "string" ? logs : logs.toString("utf-8");
}

export async function getContainerStatus(containerId: string): Promise<string> {
  const docker = await getDocker();
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  return info.State.Status; // "running", "exited", "paused", etc.
}

/**
 * Wait for a container to restart (its StartedAt changes from the given value),
 * then return the new host port mappings.
 */
export async function waitForContainerRestart(
  containerId: string,
  originalStartedAt: string,
  timeoutMs = 30_000,
): Promise<{ gatewayUrl: string; bridgeUrl: string }> {
  const docker = await getDocker();
  const container = docker.getContainer(containerId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const info = await container.inspect();
    // Container has restarted when StartedAt changes and it's running again
    if (info.State.StartedAt !== originalStartedAt && info.State.Status === "running") {
      const ports = info.NetworkSettings.Ports;
      const gatewayPort = ports["18789/tcp"]?.[0]?.HostPort;
      const bridgePort = ports["18790/tcp"]?.[0]?.HostPort;
      if (gatewayPort && bridgePort) {
        return {
          gatewayUrl: `ws://localhost:${gatewayPort}`,
          bridgeUrl: `http://localhost:${bridgePort}`,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Container did not restart within timeout");
}

/** Get a container's current StartedAt timestamp. */
export async function getContainerStartedAt(containerId: string): Promise<string> {
  const docker = await getDocker();
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  return info.State.StartedAt;
}

export async function removeInstance(containerId: string): Promise<void> {
  const docker = await getDocker();
  const container = docker.getContainer(containerId);
  try {
    await container.stop();
  } catch {
    /* may already be stopped */
  }
  await container.remove();
}
