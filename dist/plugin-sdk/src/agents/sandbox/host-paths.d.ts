export declare function isWindowsDriveAbsolutePath(raw: string): boolean;
export declare function isSandboxHostPathAbsolute(raw: string): boolean;
/**
 * Normalize a host path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 * Windows drive-letter paths preserve the drive root and uppercase the drive letter.
 */
export declare function normalizeSandboxHostPath(raw: string): string;
export declare function getSandboxHostPathPolicyKey(raw: string): string;
/**
 * Resolve a path through the deepest existing ancestor so parent symlinks are honored
 * even when the final source leaf does not exist yet.
 */
export declare function resolveSandboxHostPathViaExistingAncestor(sourcePath: string): string;
