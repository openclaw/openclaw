/**
 * Sandbox security validation — blocks dangerous Docker configurations.
 *
 * Threat model: local-trusted config, but protect against foot-guns and config injection.
 * Enforced at runtime when creating sandbox containers.
 */
export declare const BLOCKED_HOST_PATHS: string[];
export type ValidateBindMountsOptions = {
    allowedSourceRoots?: string[];
    allowSourcesOutsideAllowedRoots?: boolean;
    allowReservedContainerTargets?: boolean;
};
export type ValidateNetworkModeOptions = {
    allowContainerNamespaceJoin?: boolean;
};
export type BlockedBindReason = {
    kind: "targets";
    blockedPath: string;
} | {
    kind: "covers";
    blockedPath: string;
} | {
    kind: "non_absolute";
    sourcePath: string;
} | {
    kind: "outside_allowed_roots";
    sourcePath: string;
    allowedRoots: string[];
} | {
    kind: "reserved_target";
    targetPath: string;
    reservedPath: string;
};
/**
 * Parse the host/source path from a Docker bind mount string.
 * Format: `source:target[:mode]`
 */
export declare function parseBindSourcePath(bind: string): string;
export declare function parseBindTargetPath(bind: string): string;
/**
 * Normalize a POSIX path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 */
export declare function normalizeHostPath(raw: string): string;
/**
 * String-only blocked-path check (no filesystem I/O).
 * Blocks:
 * - binds that target blocked paths (equal or under)
 * - binds that cover the system root (mounting "/" is never safe)
 * - non-absolute source paths (relative / volume names) because they are hard to validate safely
 */
export declare function getBlockedBindReason(bind: string): BlockedBindReason | null;
export declare function getBlockedReasonForSourcePath(sourceNormalized: string): BlockedBindReason | null;
/**
 * Validate bind mounts — throws if any source path is dangerous.
 * Includes a symlink/realpath pass via existing ancestors so non-existent leaf
 * paths cannot bypass source-root and blocked-path checks.
 */
export declare function validateBindMounts(binds: string[] | undefined, options?: ValidateBindMountsOptions): void;
export declare function validateNetworkMode(network: string | undefined, options?: ValidateNetworkModeOptions): void;
export declare function validateSeccompProfile(profile: string | undefined): void;
export declare function validateApparmorProfile(profile: string | undefined): void;
export declare function validateSandboxSecurity(cfg: {
    binds?: string[];
    network?: string;
    seccompProfile?: string;
    apparmorProfile?: string;
    dangerouslyAllowContainerNamespaceJoin?: boolean;
} & ValidateBindMountsOptions): void;
