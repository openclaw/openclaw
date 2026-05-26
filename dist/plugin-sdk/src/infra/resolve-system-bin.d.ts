/**
 * Trust level for system binary resolution.
 * - "strict": Only fixed OS-managed directories. Use for security-critical
 *   binaries like openssl where a compromised binary has high impact.
 * - "standard": Strict dirs plus common local-admin/package-manager
 *   directories appended after system dirs. Use for tool binaries like
 *   ffmpeg that are rarely available via the OS itself.
 */
type SystemBinTrust = "strict" | "standard";
/**
 * Resolve a binary name to an absolute path by searching only trusted system
 * directories. Returns `null` when the binary is not found. Results are cached
 * for the lifetime of the process.
 *
 * This MUST be used instead of bare binary names in `execFile`/`spawn` calls
 * for internal infrastructure binaries (ffmpeg, ffprobe, openssl, etc.) to
 * prevent PATH-hijack attacks via user-writable directories.
 */
export declare function resolveSystemBin(name: string, opts?: {
    trust?: SystemBinTrust;
    extraDirs?: readonly string[];
}): string | null;
/** Visible for tests: the computed trusted directories. */
export declare function _getTrustedDirs(trust?: SystemBinTrust): readonly string[];
/** Reset cache and optionally override the executable-check function (for tests). */
export declare function _resetResolveSystemBin(overrideIsExecutable?: (p: string) => boolean): void;
export {};
