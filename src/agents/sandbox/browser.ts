import dns from "node:dns/promises";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "../../browser/bridge-server.js";
import { type ResolvedBrowserConfig, resolveProfile } from "../../browser/config.js";
import {
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_CLAWD_BROWSER_COLOR,
} from "../../browser/constants.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { DEFAULT_SANDBOX_BROWSER_IMAGE, SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import {
  buildSandboxCreateArgs,
  dockerContainerState,
  execDocker,
  readDockerPort,
} from "./docker.js";
import { updateBrowserRegistry } from "./registry.js";
import { slugifySessionKey } from "./shared.js";
import { isToolAllowed } from "./tool-policy.js";
import type { SandboxBrowserContext, SandboxConfig } from "./types.js";

/**
 * Resolve a hostname to an IPv4 address for CDP connections.
 * Chrome's CDP HTTP endpoints reject non-IP Host headers, so we resolve
 * hostnames like "host.docker.internal" to their IP addresses.
 */
async function resolveHostToIp(host: string): Promise<string> {
  // If already an IP address (v4 or v6), return as-is
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) {
    return host;
  }
  // localhost is special-cased by Chrome
  if (host === "localhost") {
    return host;
  }
  try {
    const result = await dns.lookup(host, { family: 4 });
    return result.address;
  } catch {
    // If DNS resolution fails, return original host and let caller handle the error
    return host;
  }
}

async function waitForSandboxCdp(params: {
  cdpHost: string;
  cdpPort: number;
  timeoutMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, params.timeoutMs);
  // Resolve hostname to IP for Chrome CDP compatibility
  const resolvedHost = await resolveHostToIp(params.cdpHost);
  const url = `http://${resolvedHost}:${params.cdpPort}/json/version`;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.ok) return true;
      } finally {
        clearTimeout(t);
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function buildSandboxBrowserResolvedConfig(params: {
  controlPort: number;
  cdpHost: string;
  cdpPort: number;
  headless: boolean;
  evaluateEnabled: boolean;
}): ResolvedBrowserConfig {
  const isLoopback =
    params.cdpHost === "127.0.0.1" || params.cdpHost === "localhost" || params.cdpHost === "::1";
  return {
    enabled: true,
    evaluateEnabled: params.evaluateEnabled,
    controlPort: params.controlPort,
    cdpProtocol: "http",
    cdpHost: params.cdpHost,
    cdpIsLoopback: isLoopback,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    color: DEFAULT_CLAWD_BROWSER_COLOR,
    executablePath: undefined,
    headless: params.headless,
    noSandbox: false,
    attachOnly: true,
    defaultProfile: "clawd",
    profiles: {
      clawd: { cdpPort: params.cdpPort, color: DEFAULT_CLAWD_BROWSER_COLOR },
    },
  };
}

async function ensureSandboxBrowserImage(image: string) {
  const result = await execDocker(["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) return;
  throw new Error(
    `Sandbox browser image not found: ${image}. Build it with scripts/sandbox-browser-setup.sh.`,
  );
}

export async function ensureSandboxBrowser(params: {
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
  evaluateEnabled?: boolean;
}): Promise<SandboxBrowserContext | null> {
  if (!params.cfg.browser.enabled) return null;
  if (!isToolAllowed(params.cfg.tools, "browser")) return null;

  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(params.scopeKey);
  const name = `${params.cfg.browser.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);
  const state = await dockerContainerState(containerName);
  if (!state.exists) {
    await ensureSandboxBrowserImage(params.cfg.browser.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE);
    const args = buildSandboxCreateArgs({
      name: containerName,
      cfg: params.cfg.docker,
      scopeKey: params.scopeKey,
      labels: { "moltbot.sandboxBrowser": "1" },
    });
    const mainMountSuffix =
      params.cfg.workspaceAccess === "ro" && params.workspaceDir === params.agentWorkspaceDir
        ? ":ro"
        : "";
    args.push("-v", `${params.workspaceDir}:${params.cfg.docker.workdir}${mainMountSuffix}`);
    if (params.cfg.workspaceAccess !== "none" && params.workspaceDir !== params.agentWorkspaceDir) {
      const agentMountSuffix = params.cfg.workspaceAccess === "ro" ? ":ro" : "";
      args.push(
        "-v",
        `${params.agentWorkspaceDir}:${SANDBOX_AGENT_WORKSPACE_MOUNT}${agentMountSuffix}`,
      );
    }
    args.push("-p", `127.0.0.1::${params.cfg.browser.cdpPort}`);
    if (params.cfg.browser.enableNoVnc && !params.cfg.browser.headless) {
      args.push("-p", `127.0.0.1::${params.cfg.browser.noVncPort}`);
    }
    args.push("-e", `CLAWDBOT_BROWSER_HEADLESS=${params.cfg.browser.headless ? "1" : "0"}`);
    args.push("-e", `CLAWDBOT_BROWSER_ENABLE_NOVNC=${params.cfg.browser.enableNoVnc ? "1" : "0"}`);
    args.push("-e", `CLAWDBOT_BROWSER_CDP_PORT=${params.cfg.browser.cdpPort}`);
    args.push("-e", `CLAWDBOT_BROWSER_VNC_PORT=${params.cfg.browser.vncPort}`);
    args.push("-e", `CLAWDBOT_BROWSER_NOVNC_PORT=${params.cfg.browser.noVncPort}`);
    args.push(params.cfg.browser.image);
    await execDocker(args);
    await execDocker(["start", containerName]);
  } else if (!state.running) {
    await execDocker(["start", containerName]);
  }

  const mappedCdp = await readDockerPort(containerName, params.cfg.browser.cdpPort);
  if (!mappedCdp) {
    throw new Error(`Failed to resolve CDP port mapping for ${containerName}.`);
  }

  const mappedNoVnc =
    params.cfg.browser.enableNoVnc && !params.cfg.browser.headless
      ? await readDockerPort(containerName, params.cfg.browser.noVncPort)
      : null;

  const existing = BROWSER_BRIDGES.get(params.scopeKey);
  const existingProfile = existing ? resolveProfile(existing.bridge.state.resolved, "clawd") : null;
  const shouldReuse =
    existing && existing.containerName === containerName && existingProfile?.cdpPort === mappedCdp;
  if (existing && !shouldReuse) {
    await stopBrowserBridgeServer(existing.bridge.server).catch(() => undefined);
    BROWSER_BRIDGES.delete(params.scopeKey);
  }

  const bridge = (() => {
    if (shouldReuse && existing) return existing.bridge;
    return null;
  })();

  const ensureBridge = async () => {
    if (bridge) return bridge;

    // Resolve hostname to IP for Chrome CDP compatibility
    const resolvedCdpHost = await resolveHostToIp(params.cfg.browser.cdpHost);

    const onEnsureAttachTarget = params.cfg.browser.autoStart
      ? async () => {
          const state = await dockerContainerState(containerName);
          if (state.exists && !state.running) {
            await execDocker(["start", containerName]);
          }
          const ok = await waitForSandboxCdp({
            cdpHost: resolvedCdpHost,
            cdpPort: mappedCdp,
            timeoutMs: params.cfg.browser.autoStartTimeoutMs,
          });
          if (!ok) {
            throw new Error(
              `Sandbox browser CDP did not become reachable on ${resolvedCdpHost}:${mappedCdp} within ${params.cfg.browser.autoStartTimeoutMs}ms.`,
            );
          }
        }
      : undefined;

    return await startBrowserBridgeServer({
      resolved: buildSandboxBrowserResolvedConfig({
        controlPort: 0,
        cdpHost: resolvedCdpHost,
        cdpPort: mappedCdp,
        headless: params.cfg.browser.headless,
        evaluateEnabled: params.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED,
      }),
      onEnsureAttachTarget,
    });
  };

  const resolvedBridge = await ensureBridge();
  if (!shouldReuse) {
    BROWSER_BRIDGES.set(params.scopeKey, {
      bridge: resolvedBridge,
      containerName,
    });
  }

  const now = Date.now();
  await updateBrowserRegistry({
    containerName,
    sessionKey: params.scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.browser.image,
    cdpPort: mappedCdp,
    noVncPort: mappedNoVnc ?? undefined,
  });

  const noVncUrl =
    mappedNoVnc && params.cfg.browser.enableNoVnc && !params.cfg.browser.headless
      ? `http://${params.cfg.browser.cdpHost}:${mappedNoVnc}/vnc.html?autoconnect=1&resize=remote`
      : undefined;

  return {
    bridgeUrl: resolvedBridge.baseUrl,
    noVncUrl,
    containerName,
  };
}
