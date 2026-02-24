/**
 * Sandbox security validation — blocks dangerous Docker configurations.
 *
 * Threat model: local-trusted config, but protect against foot-guns and config injection.
 * Enforced at runtime when creating sandbox containers.
 */

import { splitSandboxBindSpec } from "./bind-spec.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import {
  normalizeSandboxHostPath,
  resolveSandboxHostPathViaExistingAncestor,
} from "./host-paths.js";
import { getBlockedNetworkModeReason } from "./network-mode.js";

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
  // Directories that commonly contain (or alias) the Docker socket.
  "/run",
  "/var/run",
  "/private/var/run",
  "/var/run/docker.sock",
  "/private/var/run/docker.sock",
  "/run/docker.sock",
];

const BLOCKED_SECCOMP_PROFILES = new Set(["unconfined"]);
const BLOCKED_APPARMOR_PROFILES = new Set(["unconfined"]);
const RESERVED_CONTAINER_TARGET_PATHS = ["/workspace", SANDBOX_AGENT_WORKSPACE_MOUNT];

export type ValidateBindMountsOptions = {
  allowedSourceRoots?: string[];
  allowSourcesOutsideAllowedRoots?: boolean;
  allowReservedContainerTargets?: boolean;
};

export type ValidateNetworkModeOptions = {
  allowContainerNamespaceJoin?: boolean;
};

export type BlockedBindReason =
  | { kind: "targets"; blockedPath: string }
  | { kind: "covers"; blockedPath: string }
  | { kind: "non_absolute"; sourcePath: string }
  | { kind: "outside_allowed_roots"; sourcePath: string; allowedRoots: string[] }
  | { kind: "reserved_target"; targetPath: string; reservedPath: string };

type ParsedBindSpec = {
  source: string;
  target: string;
};

function parseBindSpec(bind: string): ParsedBindSpec {
  const trimmed = bind.trim();
  const parsed = splitSandboxBindSpec(trimmed);
  if (!parsed) {
    return { source: trimmed, target: "" };
  }
  return { source: parsed.host, target: parsed.container };
}

/**
 * Parse the host/source path from a Docker bind mount string.
 * Format: `source:target[:mode]`
 */
export function parseBindSourcePath(bind: string): string {
  return parseBindSpec(bind).source.trim();
}

export function parseBindTargetPath(bind: string): string {
  return parseBindSpec(bind).target.trim();
}

/**
 * Normalize a POSIX path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 */
export function normalizeHostPath(raw: string): string {
  return normalizeSandboxHostPath(raw);
}

/**
 * String-only blocked-path check (no filesystem I/O).
 * Blocks:
 * - binds that target blocked paths (equal or under)
 * - binds that cover the system root (mounting "/" is never safe)
 * - non-absolute source paths (relative / volume names) because they are hard to validate safely
 */
export function getBlockedBindReason(bind: string): BlockedBindReason | null {
  const sourceRaw = parseBindSourcePath(bind);
  if (!sourceRaw.startsWith("/")) {
    return { kind: "non_absolute", sourcePath: sourceRaw };
  }

  const normalized = normalizeHostPath(sourceRaw);
  return getBlockedReasonForSourcePath(normalized);
}

export function getBlockedReasonForSourcePath(sourceNormalized: string): BlockedBindReason | null {
  if (sourceNormalized === "/") {
    return { kind: "covers", blockedPath: "/" };
  }
  for (const blocked of BLOCKED_HOST_PATHS) {
    if (sourceNormalized === blocked || sourceNormalized.startsWith(blocked + "/")) {
      return { kind: "targets", blockedPath: blocked };
    }
  }

  return null;
}

function normalizeAllowedRoots(roots: string[] | undefined): string[] {
  if (!roots?.length) {
    return [];
  }
  const normalized = roots
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("/"))
    .map(normalizeHostPath);
  const expanded = new Set<string>();
  for (const root of normalized) {
    expanded.add(root);
    const real = resolveSandboxHostPathViaExistingAncestor(root);
    if (real !== root) {
      expanded.add(real);
    }
  }
  return [...expanded];
}

function isPathInsidePosix(root: string, target: string): boolean {
  if (root === "/") {
    return true;
  }
  return target === root || target.startsWith(`${root}/`);
}

function getOutsideAllowedRootsReason(
  sourceNormalized: string,
  allowedRoots: string[],
): BlockedBindReason | null {
  if (allowedRoots.length === 0) {
    return null;
  }
  for (const root of allowedRoots) {
    if (isPathInsidePosix(root, sourceNormalized)) {
      return null;
    }
  }
  return {
    kind: "outside_allowed_roots",
    sourcePath: sourceNormalized,
    allowedRoots,
  };
}

function getReservedTargetReason(bind: string): BlockedBindReason | null {
  const targetRaw = parseBindTargetPath(bind);
  if (!targetRaw || !targetRaw.startsWith("/")) {
    return null;
  }
  const target = normalizeHostPath(targetRaw);
  for (const reserved of RESERVED_CONTAINER_TARGET_PATHS) {
    if (isPathInsidePosix(reserved, target)) {
      return {
        kind: "reserved_target",
        targetPath: target,
        reservedPath: reserved,
      };
    }
  }
  return null;
}

function enforceSourcePathPolicy(params: {
  bind: string;
  sourcePath: string;
  allowedRoots: string[];
  allowSourcesOutsideAllowedRoots: boolean;
}): void {
  const blockedReason = getBlockedReasonForSourcePath(params.sourcePath);
  if (blockedReason) {
    throw formatBindBlockedError({ bind: params.bind, reason: blockedReason });
  }
  if (params.allowSourcesOutsideAllowedRoots) {
    return;
  }
  const allowedReason = getOutsideAllowedRootsReason(params.sourcePath, params.allowedRoots);
  if (allowedReason) {
    throw formatBindBlockedError({ bind: params.bind, reason: allowedReason });
  }
}

function formatBindBlockedError(params: { bind: string; reason: BlockedBindReason }): Error {
  if (params.reason.kind === "non_absolute") {
    return new Error(
      `Sandbox security: bind mount "${params.bind}" uses a non-absolute source path ` +
        `"${params.reason.sourcePath}". Only absolute POSIX paths are supported for sandbox binds.`,
    );
  }
  if (params.reason.kind === "outside_allowed_roots") {
    return new Error(
      `Sandbox security: bind mount "${params.bind}" source "${params.reason.sourcePath}" is outside allowed roots ` +
        `(${params.reason.allowedRoots.join(", ")}). Use a dangerous override only when you fully trust this runtime.`,
    );
  }
  if (params.reason.kind === "reserved_target") {
    return new Error(
      `Sandbox security: bind mount "${params.bind}" targets reserved container path "${params.reason.reservedPath}" ` +
        `(resolved target: "${params.reason.targetPath}"). This can shadow OpenClaw sandbox mounts. ` +
        "Use a dangerous override only when you fully trust this runtime.",
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
 * Includes a symlink/realpath pass via existing ancestors so non-existent leaf
 * paths cannot bypass source-root and blocked-path checks.
 */
export function validateBindMounts(
  binds: string[] | undefined,
  options?: ValidateBindMountsOptions,
): void {
  if (!binds?.length) {
    return;
  }

  const allowedRoots = normalizeAllowedRoots(options?.allowedSourceRoots);

  for (const rawBind of binds) {
    const bind = rawBind.trim();
    if (!bind) {
      continue;
    }

    // Fast string-only check (covers .., //, ancestor/descendant logic).
    const blocked = getBlockedBindReason(bind);
    if (blocked) {
      throw formatBindBlockedError({ bind, reason: blocked });
    }

    if (!options?.allowReservedContainerTargets) {
      const reservedTarget = getReservedTargetReason(bind);
      if (reservedTarget) {
        throw formatBindBlockedError({ bind, reason: reservedTarget });
      }
    }

    const sourceRaw = parseBindSourcePath(bind);
    const sourceNormalized = normalizeHostPath(sourceRaw);
    enforceSourcePathPolicy({
      bind,
      sourcePath: sourceNormalized,
      allowedRoots,
      allowSourcesOutsideAllowedRoots: options?.allowSourcesOutsideAllowedRoots === true,
    });

    // Symlink escape hardening: resolve through existing ancestors and re-check.
    const sourceCanonical = resolveSandboxHostPathViaExistingAncestor(sourceNormalized);
    enforceSourcePathPolicy({
      bind,
      sourcePath: sourceCanonical,
      allowedRoots,
      allowSourcesOutsideAllowedRoots: options?.allowSourcesOutsideAllowedRoots === true,
    });
  }
}

export function validateNetworkMode(
  network: string | undefined,
  options?: ValidateNetworkModeOptions,
): void {
  const blockedReason = getBlockedNetworkModeReason({
    network,
    allowContainerNamespaceJoin: options?.allowContainerNamespaceJoin,
  });
  if (blockedReason === "host") {
    throw new Error(
      `Sandbox security: network mode "${network}" is blocked. ` +
        'Network "host" mode bypasses container network isolation. ' +
        'Use "bridge" or "none" instead.',
    );
  }

  if (blockedReason === "container_namespace_join") {
    throw new Error(
      `Sandbox security: network mode "${network}" is blocked by default. ` +
        'Network "container:*" joins another container namespace and bypasses sandbox network isolation. ' +
        "Use a custom bridge network, or set dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime.",
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

export function validateSandboxSecurity(
  cfg: {
    binds?: string[];
    network?: string;
    seccompProfile?: string;
    apparmorProfile?: string;
    dangerouslyAllowContainerNamespaceJoin?: boolean;
  } & ValidateBindMountsOptions,
): void {
  validateBindMounts(cfg.binds, cfg);
  validateNetworkMode(cfg.network, {
    allowContainerNamespaceJoin: cfg.dangerouslyAllowContainerNamespaceJoin === true,
  });
  validateSeccompProfile(cfg.seccompProfile);
  validateApparmorProfile(cfg.apparmorProfile);
}
