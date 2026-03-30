export declare function isProfileDecorated(userDataDir: string, desiredName: string, desiredColorHex: string): boolean;
/**
 * Best-effort profile decoration (name + lobster-orange). Chrome preference keys
 * vary by version; we keep this conservative and idempotent.
 */
export declare function decorateOpenClawProfile(userDataDir: string, opts?: {
    name?: string;
    color?: string;
}): void;
export declare function ensureProfileCleanExit(userDataDir: string): void;
