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

export async function allocateCdpPort(
  usedPorts: Set<number>,
  range?: { start: number; end: number },
): Promise<number | null> {
  const start = range?.start ?? CDP_PORT_RANGE_START;
  const end = range?.end ?? CDP_PORT_RANGE_END;
  if (!isValidTcpPort(start) || !isValidTcpPort(end) || start > end) {
    return null;
  }
  for (let port = start; port <= end; port++) {
    // Config cannot see listeners owned by other processes, such as another
    // Gateway's Chrome on this host. The probe does not reserve the port;
    // launch still checks it before Chrome binds.
    if (!usedPorts.has(port) && (await isLoopbackPortFree(port))) {
      return port;
    }
  }
  return null;
}

async function isLoopbackPortFree(port: number): Promise<boolean> {
  try {
    // Chromium binds its DevTools listener on IPv4 loopback.
    await ensurePortAvailable(port, "127.0.0.1");
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "PortInUseError") {
      return false;
    }
    throw err;
  }
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
