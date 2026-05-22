/**
 * Normalize a POSIX host path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 */
export declare function normalizeSandboxHostPath(raw: string): string;
/**
 * Resolve a path through the deepest existing ancestor so parent symlinks are honored
 * even when the final source leaf does not exist yet.
 */
export declare function resolveSandboxHostPathViaExistingAncestor(sourcePath: string): string;
