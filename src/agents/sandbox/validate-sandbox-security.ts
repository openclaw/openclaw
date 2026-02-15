/**
 * Sandbox security validation — blocks dangerous Docker configurations.
 *
 * Validates bind mounts, network modes, and seccomp profiles to prevent
 * container escape via config injection (OC-13).
 */

import { posix } from "node:path";

// Specific dangerous host paths — targeted denylist (not broad directory trees).
// Exported for reuse in security audit collector (audit-extra.sync.ts).
export const BLOCKED_HOST_PATHS = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/root",
  "/boot",
  "/var/run/docker.sock",
];

const BLOCKED_NETWORK_MODES = new Set(["host"]);
const BLOCKED_SECCOMP_PROFILES = new Set(["unconfined"]);

/**
 * Normalize a host path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 */
function normalizeHostPath(raw: string): string {
  // posix.normalize handles `..`, `.`, and `//`
  return posix.normalize(raw).replace(/\/+$/, "") || "/";
}

/**
 * Parse the host path from a Docker bind mount string.
 * Format: `host_path:container_path[:mode]`
 */
function parseHostPath(bind: string): string {
  const firstColon = bind.indexOf(":");
  if (firstColon <= 0) {
    // No colon or starts with colon — treat the whole string as the host path
    return bind;
  }
  return bind.slice(0, firstColon);
}

/**
 * Check if a normalized path is under (or equal to) a blocked path.
 */
function isBlockedPath(normalized: string): string | null {
  for (const blocked of BLOCKED_HOST_PATHS) {
    if (normalized === blocked || normalized.startsWith(blocked + "/")) {
      return blocked;
    }
  }
  return null;
}

/**
 * Validate bind mounts — throws if any host path resolves to a dangerous location.
 */
export function validateBindMounts(binds: string[] | undefined): void {
  if (!binds?.length) {
    return;
  }
  for (const bind of binds) {
    const hostPath = normalizeHostPath(parseHostPath(bind));
    const blocked = isBlockedPath(hostPath);
    if (blocked) {
      throw new Error(
        `Sandbox security: bind mount "${bind}" targets blocked path "${blocked}". ` +
          "Mounting system directories into sandbox containers is not allowed. " +
          "Use project-specific paths instead (e.g. /home/user/myproject).",
      );
    }
  }
}

/**
 * Validate network mode — throws if "host" mode is requested.
 */
export function validateNetworkMode(network: string | undefined): void {
  if (network && BLOCKED_NETWORK_MODES.has(network.toLowerCase())) {
    throw new Error(
      `Sandbox security: network mode "${network}" is blocked. ` +
        'Network "host" mode bypasses container network isolation. ' +
        'Use "bridge" or "none" instead.',
    );
  }
}

/**
 * Validate seccomp profile — throws if "unconfined" is requested.
 */
export function validateSeccompProfile(profile: string | undefined): void {
  if (profile && BLOCKED_SECCOMP_PROFILES.has(profile.toLowerCase())) {
    throw new Error(
      `Sandbox security: seccomp profile "${profile}" is blocked. ` +
        "Disabling seccomp removes syscall filtering and weakens sandbox isolation. " +
        "Use a custom seccomp profile file or omit this setting.",
    );
  }
}

/**
 * Run all sandbox security validations on a Docker config.
 * Call this at the start of buildSandboxCreateArgs for runtime enforcement.
 */
export function validateSandboxSecurity(cfg: {
  binds?: string[];
  network?: string;
  seccompProfile?: string;
}): void {
  validateBindMounts(cfg.binds);
  validateNetworkMode(cfg.network);
  validateSeccompProfile(cfg.seccompProfile);
}
