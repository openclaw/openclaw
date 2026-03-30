import { type RuntimeEnv } from "../runtime.js";
import type { WebChannel } from "../utils.js";
export declare function resolveDefaultWebAuthDir(): string;
export declare const WA_WEB_AUTH_DIR: string;
export declare function resolveWebCredsPath(authDir: string): string;
export declare function resolveWebCredsBackupPath(authDir: string): string;
export declare function hasWebCredsSync(authDir: string): boolean;
export declare function readCredsJsonRaw(filePath: string): string | null;
export declare function maybeRestoreCredsFromBackup(authDir: string): void;
export declare function webAuthExists(authDir?: string): Promise<boolean>;
export declare function logoutWeb(params: {
    authDir?: string;
    isLegacyAuthDir?: boolean;
    runtime?: RuntimeEnv;
}): Promise<boolean>;
export declare function readWebSelfId(authDir?: string): {
    readonly e164: string | null;
    readonly jid: string | null;
};
/**
 * Return the age (in milliseconds) of the cached WhatsApp web auth state, or null when missing.
 * Helpful for heartbeats/observability to spot stale credentials.
 */
export declare function getWebAuthAgeMs(authDir?: string): number | null;
export declare function logWebSelfId(authDir?: string, runtime?: RuntimeEnv, includeChannelPrefix?: boolean): void;
export declare function pickWebChannel(pref: WebChannel | "auto", authDir?: string): Promise<WebChannel>;
