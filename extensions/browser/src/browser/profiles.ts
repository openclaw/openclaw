import net from "node:net";
import { parseBrowserHttpUrl } from "openclaw/plugin-sdk/browser-cdp";
// Ports are allocated at profile creation and persisted. Callers can pass a
// derived range for Gateways that use a non-default control port.
const CDP_PORT_RANGE_START = 18800;
const CDP_PORT_RANGE_END = 18899;
const MAX_TCP_PORT = 65_535;

const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function isValidProfileName(name: string): boolean {
  return Boolean(name) && name.length <= 64 && PROFILE_NAME_REGEX.test(name);
}

/** Binds a temporary loopback listener to verify that a port is actually free. */
async function isTcpPortBindable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * Walks the allocation range, skipping ports the config already reserves and
 * ports a live listener already holds: several Gateways share one host, and
 * each derives an overlapping candidate range from its own control port, so
 * config-only exclusion cannot see a neighbour's listeners.
 */
export async function allocateFreeCdpPort(
  usedPorts: Set<number>,
  range?: { start: number; end: number },
  isPortFree: (port: number) => Promise<boolean> = isTcpPortBindable,
): Promise<number | null> {
  const start = range?.start ?? CDP_PORT_RANGE_START;
  const end = range?.end ?? CDP_PORT_RANGE_END;
  if (!isValidTcpPort(start) || !isValidTcpPort(end) || start > end) {
    return null;
  }
  for (let port = start; port <= end; port++) {
    if (usedPorts.has(port)) {
      continue;
    }
    if (await isPortFree(port)) {
      return port;
    }
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
