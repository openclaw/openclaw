/**
 * Sandbox security validation — blocks dangerous Docker configurations.
 *
 * Threat model: local-trusted config, but protect against foot-guns and config injection.
 * Enforced at runtime when creating sandbox containers.
 */

import { existsSync, realpathSync } from "node:fs";
import { posix } from "node:path";

// Targeted denylist: host paths that should never be exposed inside sandbox containers.
// Exported for reuse in security audit collectors.
export const BLOCKED_HOST_PATHS = [
  "/etc",
  "/private/etc",
  "/proc",
  "/sys",
  "/dev",
  "/root",
  "/boot",
  "/var/run/docker.sock",
  "/private/var/run/docker.sock",
  "/run/docker.sock",
];

const BLOCKED_NETWORK_MODES = new Set(["host"]);
const BLOCKED_SECCOMP_PROFILES = new Set(["unconfined"]);
const BLOCKED_APPARMOR_PROFILES = new Set(["unconfined"]);

export type BlockedBindReason =
  | { kind: "targets"; blockedPath: string }
  | { kind: "covers"; blockedPath: string }
  | { kind: "non_absolute"; sourcePath: string };

/**
 * Parse the host/source path from a Docker bind mount string.
 * Format: `source:target[:mode]`
 */
export function parseBindSourcePath(bind: string): string {
  const trimmed = bind.trim();
  const firstColon = trimmed.indexOf(":");
  if (firstColon <= 0) {
    // No colon or starts with colon — treat as source.
    return trimmed;
  }
  return trimmed.slice(0, firstColon);
}

/**
 * Normalize a POSIX path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 */
export function normalizeHostPath(raw: string): string {
  const trimmed = raw.trim();
  return posix.normalize(trimmed).replace(/\/+$/, "") || "/";
}

/**
 * String-only blocked-path check (no filesystem I/O).
 * Blocks:
 * - binds that target blocked paths (equal or under)
 * - binds that cover blocked paths (ancestor mounts like /run or /var)
 * - non-absolute source paths (relative / volume names) because they are hard to validate safely
 */
export function getBlockedBindReasonStringOnly(bind: string): BlockedBindReason | null {
  const sourceRaw = parseBindSourcePath(bind);
  if (!sourceRaw.startsWith("/")) {
    return { kind: "non_absolute", sourcePath: sourceRaw };
  }

  const normalized = normalizeHostPath(sourceRaw);

  for (const blocked of BLOCKED_HOST_PATHS) {
    if (normalized === blocked || normalized.startsWith(blocked + "/")) {
      return { kind: "targets", blockedPath: blocked };
    }
    // Ancestor mounts: mounting /run exposes /run/docker.sock.
    if (normalized === "/") {
      return { kind: "covers", blockedPath: blocked };
    }
    if (blocked.startsWith(normalized + "/")) {
      return { kind: "covers", blockedPath: blocked };
    }
  }

  return null;
}

function tryRealpathAbsolute(path: string): string {
  if (!path.startsWith("/")) {
    return path;
  }
  if (!existsSync(path)) {
    return path;
  }
  try {
    // Use native when available (keeps platform semantics); normalize for prefix checks.
    return normalizeHostPath(realpathSync.native(path));
  } catch {
    return path;
  }
}

function formatBindBlockedError(params: { bind: string; reason: BlockedBindReason }): Error {
  if (params.reason.kind === "non_absolute") {
    return new Error(
      `Sandbox security: bind mount "${params.bind}" uses a non-absolute source path ` +
        `"${params.reason.sourcePath}". Only absolute POSIX paths are supported for sandbox binds.`,
    );
  }
  const verb = params.reason.kind === "covers" ? "covers" : "targets";
  return new Error(
    `Sandbox security: bind mount "${params.bind}" ${verb} blocked path "${params.reason.blockedPath}". ` +
      "Mounting system directories (or Docker socket paths) into sandbox containers is not allowed. " +
      "Use project-specific paths instead (e.g. /home/user/myproject).",
  );
}

/**
 * Validate bind mounts — throws if any source path is dangerous.
 * Includes a symlink/realpath pass when the source path exists.
 */
export function validateBindMounts(binds: string[] | undefined): void {
  if (!binds?.length) {
    return;
  }

  for (const rawBind of binds) {
    const bind = rawBind.trim();
    if (!bind) {
      continue;
    }

    // Fast string-only check (covers .., //, ancestor/descendant logic).
    const blocked = getBlockedBindReasonStringOnly(bind);
    if (blocked) {
      throw formatBindBlockedError({ bind, reason: blocked });
    }

    // Symlink escape hardening: resolve existing absolute paths and re-check.
    const sourceRaw = parseBindSourcePath(bind);
    const sourceNormalized = normalizeHostPath(sourceRaw);
    const sourceReal = tryRealpathAbsolute(sourceNormalized);
    if (sourceReal !== sourceNormalized) {
      for (const blockedPath of BLOCKED_HOST_PATHS) {
        if (sourceReal === blockedPath || sourceReal.startsWith(blockedPath + "/")) {
          throw formatBindBlockedError({
            bind,
            reason: { kind: "targets", blockedPath },
          });
        }
        if (sourceReal === "/") {
          throw formatBindBlockedError({
            bind,
            reason: { kind: "covers", blockedPath },
          });
        }
        if (blockedPath.startsWith(sourceReal + "/")) {
          throw formatBindBlockedError({
            bind,
            reason: { kind: "covers", blockedPath },
          });
        }
      }
    }
  }
}

export function validateNetworkMode(network: string | undefined): void {
  if (network && BLOCKED_NETWORK_MODES.has(network.trim().toLowerCase())) {
    throw new Error(
      `Sandbox security: network mode "${network}" is blocked. ` +
        'Network "host" mode bypasses container network isolation. ' +
        'Use "bridge" or "none" instead.',
    );
  }
}

export function validateSeccompProfile(profile: string | undefined): void {
  if (profile && BLOCKED_SECCOMP_PROFILES.has(profile.trim().toLowerCase())) {
    throw new Error(
      `Sandbox security: seccomp profile "${profile}" is blocked. ` +
        "Disabling seccomp removes syscall filtering and weakens sandbox isolation. " +
        "Use a custom seccomp profile file or omit this setting.",
    );
  }
}

export function validateApparmorProfile(profile: string | undefined): void {
  if (profile && BLOCKED_APPARMOR_PROFILES.has(profile.trim().toLowerCase())) {
    throw new Error(
      `Sandbox security: apparmor profile "${profile}" is blocked. ` +
        "Disabling AppArmor removes mandatory access controls and weakens sandbox isolation. " +
        "Use a named AppArmor profile or omit this setting.",
    );
  }
}

export function validateSandboxSecurity(cfg: {
  binds?: string[];
  network?: string;
  seccompProfile?: string;
  apparmorProfile?: string;
}): void {
  validateBindMounts(cfg.binds);
  validateNetworkMode(cfg.network);
  validateSeccompProfile(cfg.seccompProfile);
  validateApparmorProfile(cfg.apparmorProfile);
}
