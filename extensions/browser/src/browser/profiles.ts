import { parseBrowserHttpUrl } from "openclaw/plugin-sdk/browser-cdp";
import { ensurePortAvailable } from "openclaw/plugin-sdk/security-runtime";
// Ports are allocated at profile creation and persisted. Callers can pass a
// derived range for Gateways that use a non-default control port.
const CDP_PORT_RANGE_START = 18800;
const CDP_PORT_RANGE_END = 18899;
const MAX_TCP_PORT = 65_535;

const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function isValidProfileName(name: string): boolean {
  return Boolean(name) && name.length <= 64 && PROFILE_NAME_REGEX.test(name);
}

export function allocateCdpPort(
  usedPorts: Set<number>,
  range?: { start: number; end: number },
): number | null {
  const start = range?.start ?? CDP_PORT_RANGE_START;
  const end = range?.end ?? CDP_PORT_RANGE_END;
  if (!isValidTcpPort(start) || !isValidTcpPort(end) || start > end) {
    return null;
  }
  for (let port = start; port <= end; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }
  return null;
}

async function isLoopbackPortFree(port: number): Promise<boolean> {
  try {
    // Managed Chromium binds IPv4 loopback first; launch checks the same host.
    await ensurePortAvailable(port, "127.0.0.1");
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "PortInUseError") {
      return false;
    }
    throw err;
  }
}

/**
 * Like allocateCdpPort, but skips ports another process already listens on. Profiles only
 * reserve ports within this config, so a neighboring Gateway's range can overlap them.
 */
export async function allocateAvailableCdpPort(
  usedPorts: Set<number>,
  range?: { start: number; end: number },
  isFree: (port: number) => Promise<boolean> = isLoopbackPortFree,
): Promise<number | null> {
  const skipped = new Set(usedPorts);
  for (let port = allocateCdpPort(skipped, range); port !== null;) {
    if (await isFree(port)) {
      return port;
    }
    skipped.add(port);
    port = allocateCdpPort(skipped, range);
  }
  return null;
}

function isValidTcpPort(port: number): boolean {
  return Number.isSafeInteger(port) && port > 0 && port <= MAX_TCP_PORT;
}

export function getUsedPorts(
  profiles: Record<string, { cdpPort?: number; cdpUrl?: string }> | undefined,
): Set<number> {
  const used = new Set<number>();
  for (const profile of Object.values(profiles ?? {})) {
    if (typeof profile.cdpPort === "number" && isValidTcpPort(profile.cdpPort)) {
      used.add(profile.cdpPort);
      continue;
    }
    const rawUrl = profile.cdpUrl?.trim();
    if (!rawUrl) {
      continue;
    }
    try {
      used.add(parseBrowserHttpUrl(rawUrl, "browser.profiles.*.cdpUrl").port);
    } catch {
      // An invalid configured URL does not reserve a port.
    }
  }
  return used;
}
