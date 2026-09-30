import { parseBrowserHttpUrl } from "openclaw/plugin-sdk/browser-cdp";
// Ports are allocated at profile creation and persisted. Callers can pass a
// derived range for Gateways that use a non-default control port.
const CDP_PORT_RANGE_START = 18800;
const CDP_PORT_RANGE_END = 18899;
const MAX_TCP_PORT = 65_535;

const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/** Return true when a profile name matches the supported config key format. */
export function isValidProfileName(name: string): boolean {
  if (!name || name.length > 64) {
    return false;
  }
  return PROFILE_NAME_REGEX.test(name);
}

/** Allocate the first unused CDP port in the configured range. */
export function allocateCdpPort(
  usedPorts: Set<number>,
  range?: { start: number; end: number },
): number | null {
  const start = range?.start ?? CDP_PORT_RANGE_START;
  const end = range?.end ?? CDP_PORT_RANGE_END;
  if (!isValidTcpPort(start) || !isValidTcpPort(end)) {
    return null;
  }
  if (start > end) {
    return null;
  }
  for (let port = start; port <= end; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }
  return null;
}

function isValidTcpPort(port: number): boolean {
  return Number.isSafeInteger(port) && port > 0 && port <= MAX_TCP_PORT;
}

/** Extract currently used CDP ports from profile config. */
export function getUsedPorts(
  profiles: Record<string, { cdpPort?: number; cdpUrl?: string }> | undefined,
): Set<number> {
  if (!profiles) {
    return new Set();
  }
  const used = new Set<number>();
  for (const profile of Object.values(profiles)) {
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
      // ignore invalid URLs
    }
  }
  return used;
}
