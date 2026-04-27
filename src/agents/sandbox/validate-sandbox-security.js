/**
 * Sandbox security validation — blocks dangerous Docker configurations.
 *
 * Threat model: local-trusted config, but protect against foot-guns and config injection.
 * Enforced at runtime when creating sandbox containers.
 */
import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir, resolveRequiredOsHomeDir } from "../../infra/home-dir.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import { normalizeSandboxHostPath, resolveSandboxHostPathViaExistingAncestor, } from "./host-paths.js";
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
const BLOCKED_HOME_SUBPATHS = [
    ".aws",
    ".cargo",
    ".config",
    ".docker",
    ".gnupg",
    ".netrc",
    ".npm",
    ".ssh",
];
const BLOCKED_SECCOMP_PROFILES = new Set(["unconfined"]);
const BLOCKED_APPARMOR_PROFILES = new Set(["unconfined"]);
const RESERVED_CONTAINER_TARGET_PATHS = ["/workspace", SANDBOX_AGENT_WORKSPACE_MOUNT];
let blockedHostPathsCache;
function parseBindSpec(bind) {
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
export function parseBindSourcePath(bind) {
    return parseBindSpec(bind).source.trim();
}
export function parseBindTargetPath(bind) {
    return parseBindSpec(bind).target.trim();
}
/**
 * Normalize a POSIX path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 */
export function normalizeHostPath(raw) {
    return normalizeSandboxHostPath(raw);
}
/**
 * String-only blocked-path check (no filesystem I/O).
 * Blocks:
 * - binds that target blocked paths (equal or under)
 * - binds that cover the system root (mounting "/" is never safe)
 * - non-absolute source paths (relative / volume names) because they are hard to validate safely
 */
export function getBlockedBindReason(bind) {
    const sourceRaw = parseBindSourcePath(bind);
    if (!sourceRaw.startsWith("/")) {
        return { kind: "non_absolute", sourcePath: sourceRaw };
    }
    const normalized = normalizeHostPath(sourceRaw);
    const blockedHostPaths = getBlockedHostPaths();
    const directReason = getBlockedReasonForSourcePath(normalized, blockedHostPaths);
    if (directReason) {
        return directReason;
    }
    const canonical = resolveSandboxHostPathViaExistingAncestor(normalized);
    if (canonical !== normalized) {
        return getBlockedReasonForSourcePath(canonical, blockedHostPaths);
    }
    return null;
}
export function getBlockedReasonForSourcePath(sourceNormalized, blockedHostPaths) {
    if (sourceNormalized === "/") {
        return { kind: "covers", blockedPath: "/" };
    }
    for (const blocked of blockedHostPaths) {
        if (sourceNormalized === blocked || sourceNormalized.startsWith(blocked + "/")) {
            return { kind: "targets", blockedPath: blocked };
        }
    }
    return null;
}
function getBlockedHostPaths() {
    const cacheKey = JSON.stringify({
        home: process.env.HOME,
        openclawHome: process.env.OPENCLAW_HOME,
        osHome: os.homedir(),
    });
    if (blockedHostPathsCache?.key === cacheKey) {
        return blockedHostPathsCache.paths;
    }
    const blocked = new Set(BLOCKED_HOST_PATHS.map(normalizeHostPath));
    for (const home of getBlockedHomeRoots()) {
        for (const suffix of BLOCKED_HOME_SUBPATHS) {
            blocked.add(normalizeHostPath(path.posix.join(home, suffix)));
        }
    }
    blockedHostPathsCache = { key: cacheKey, paths: [...blocked] };
    return blockedHostPathsCache.paths;
}
function getBlockedHomeRoots() {
    const roots = new Set();
    for (const candidate of [
        resolveRequiredHomeDir(process.env, os.homedir),
        resolveRequiredOsHomeDir(process.env, os.homedir),
    ]) {
        const normalized = normalizeHostPath(candidate);
        if (normalized !== "/") {
            roots.add(normalized);
        }
        const canonical = resolveSandboxHostPathViaExistingAncestor(normalized);
        if (canonical !== "/") {
            roots.add(canonical);
        }
    }
    return [...roots];
}
function normalizeAllowedRoots(roots) {
    if (!roots?.length) {
        return [];
    }
    const normalized = roots
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("/"))
        .map(normalizeHostPath);
    const expanded = new Set();
    for (const root of normalized) {
        expanded.add(root);
        const real = resolveSandboxHostPathViaExistingAncestor(root);
        if (real !== root) {
            expanded.add(real);
        }
    }
    return [...expanded];
}
function isPathInsidePosix(root, target) {
    if (root === "/") {
        return true;
    }
    return target === root || target.startsWith(`${root}/`);
}
function getOutsideAllowedRootsReason(sourceNormalized, allowedRoots) {
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
function getReservedTargetReason(bind) {
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
function enforceSourcePathPolicy(params) {
    const blockedReason = getBlockedReasonForSourcePath(params.sourcePath, params.blockedHostPaths);
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
function formatBindBlockedError(params) {
    if (params.reason.kind === "non_absolute") {
        return new Error(`Sandbox security: bind mount "${params.bind}" uses a non-absolute source path ` +
            `"${params.reason.sourcePath}". Only absolute POSIX paths are supported for sandbox binds.`);
    }
    if (params.reason.kind === "outside_allowed_roots") {
        return new Error(`Sandbox security: bind mount "${params.bind}" source "${params.reason.sourcePath}" is outside allowed roots ` +
            `(${params.reason.allowedRoots.join(", ")}). Use a dangerous override only when you fully trust this runtime.`);
    }
    if (params.reason.kind === "reserved_target") {
        return new Error(`Sandbox security: bind mount "${params.bind}" targets reserved container path "${params.reason.reservedPath}" ` +
            `(resolved target: "${params.reason.targetPath}"). This can shadow OpenClaw sandbox mounts. ` +
            "Use a dangerous override only when you fully trust this runtime.");
    }
    const verb = params.reason.kind === "covers" ? "covers" : "targets";
    return new Error(`Sandbox security: bind mount "${params.bind}" ${verb} blocked path "${params.reason.blockedPath}". ` +
        "Mounting system directories, credential paths, or Docker socket paths into sandbox containers is not allowed. " +
        "Use project-specific paths instead (e.g. /home/user/myproject).");
}
/**
 * Validate bind mounts — throws if any source path is dangerous.
 * Includes a symlink/realpath pass via existing ancestors so non-existent leaf
 * paths cannot bypass source-root and blocked-path checks.
 */
export function validateBindMounts(binds, options) {
    if (!binds?.length) {
        return;
    }
    const allowedRoots = normalizeAllowedRoots(options?.allowedSourceRoots);
    const blockedHostPaths = getBlockedHostPaths();
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
            blockedHostPaths,
            allowSourcesOutsideAllowedRoots: options?.allowSourcesOutsideAllowedRoots === true,
        });
        // Symlink escape hardening: resolve through existing ancestors and re-check.
        const sourceCanonical = resolveSandboxHostPathViaExistingAncestor(sourceNormalized);
        enforceSourcePathPolicy({
            bind,
            sourcePath: sourceCanonical,
            allowedRoots,
            blockedHostPaths,
            allowSourcesOutsideAllowedRoots: options?.allowSourcesOutsideAllowedRoots === true,
        });
    }
}
export function validateNetworkMode(network, options) {
    const blockedReason = getBlockedNetworkModeReason({
        network,
        allowContainerNamespaceJoin: options?.allowContainerNamespaceJoin,
    });
    if (blockedReason === "host") {
        throw new Error(`Sandbox security: network mode "${network}" is blocked. ` +
            'Network "host" mode bypasses container network isolation. ' +
            'Use "bridge" or "none" instead.');
    }
    if (blockedReason === "container_namespace_join") {
        throw new Error(`Sandbox security: network mode "${network}" is blocked by default. ` +
            'Network "container:*" joins another container namespace and bypasses sandbox network isolation. ' +
            "Use a custom bridge network, or set dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime.");
    }
}
export function validateSeccompProfile(profile) {
    if (profile && BLOCKED_SECCOMP_PROFILES.has(normalizeOptionalLowercaseString(profile) ?? "")) {
        throw new Error(`Sandbox security: seccomp profile "${profile}" is blocked. ` +
            "Disabling seccomp removes syscall filtering and weakens sandbox isolation. " +
            "Use a custom seccomp profile file or omit this setting.");
    }
}
export function validateApparmorProfile(profile) {
    if (profile && BLOCKED_APPARMOR_PROFILES.has(normalizeOptionalLowercaseString(profile) ?? "")) {
        throw new Error(`Sandbox security: apparmor profile "${profile}" is blocked. ` +
            "Disabling AppArmor removes mandatory access controls and weakens sandbox isolation. " +
            "Use a named AppArmor profile or omit this setting.");
    }
}
export function validateSandboxSecurity(cfg) {
    validateBindMounts(cfg.binds, cfg);
    validateNetworkMode(cfg.network, {
        allowContainerNamespaceJoin: cfg.dangerouslyAllowContainerNamespaceJoin === true,
    });
    validateSeccompProfile(cfg.seccompProfile);
    validateApparmorProfile(cfg.apparmorProfile);
}
