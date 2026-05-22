import { type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { hasWebCredsSync, resolveWebCredsBackupPath, resolveWebCredsPath } from "./creds-files.js";
import { type WhatsAppSelfIdentity } from "./identity.js";
import { type WebChannel } from "./text-runtime.js";
export { hasWebCredsSync, resolveWebCredsBackupPath, resolveWebCredsPath };
export declare const WHATSAPP_AUTH_UNSTABLE_CODE = "whatsapp-auth-unstable";
export type WhatsAppWebAuthState = "linked" | "not-linked" | "unstable";
export declare class WhatsAppAuthUnstableError extends Error {
    readonly code = "whatsapp-auth-unstable";
    constructor(message?: string);
}
export declare function resolveDefaultWebAuthDir(): string;
export declare const WA_WEB_AUTH_DIR: string;
export declare function readCredsJsonRaw(filePath: string): string | null;
export declare function restoreCredsFromBackupIfNeeded(authDir: string): Promise<boolean>;
export declare function webAuthExists(authDir?: string): Promise<boolean>;
export declare function formatWhatsAppWebAuthStatusState(state: WhatsAppWebAuthState): string;
export declare function readWebAuthState(authDir?: string): Promise<WhatsAppWebAuthState>;
export declare function readWebAuthSnapshot(authDir?: string): Promise<{
    readonly state: WhatsAppWebAuthState;
    readonly authAgeMs: number | null;
    readonly selfId: {
        readonly e164: string | null;
        readonly jid: string | null;
        readonly lid: string | null;
    };
}>;
export declare function readWebAuthExistsBestEffort(authDir?: string): Promise<{
    readonly exists: boolean;
    readonly timedOut: boolean;
}>;
export declare function readWebAuthExistsForDecision(authDir?: string): Promise<{
    outcome: "stable";
    exists: boolean;
} | {
    outcome: "unstable";
}>;
export declare function readWebAuthSnapshotBestEffort(authDir?: string): Promise<{
    readonly linked: boolean;
    readonly timedOut: boolean;
    readonly authAgeMs: number | null;
    readonly selfId: {
        readonly e164: string | null;
        readonly jid: string | null;
        readonly lid: string | null;
    };
}>;
export declare function logoutWeb(params: {
    authDir?: string;
    isLegacyAuthDir?: boolean;
    runtime?: RuntimeEnv;
}): Promise<boolean>;
export declare function readWebSelfId(authDir?: string): {
    readonly e164: string | null;
    readonly jid: string | null;
    readonly lid: string | null;
};
export declare function readWebSelfIdentity(authDir?: string, fallback?: {
    id?: string | null;
    lid?: string | null;
} | null): Promise<WhatsAppSelfIdentity>;
export declare function readWebSelfIdentityForDecision(authDir?: string, fallback?: {
    id?: string | null;
    lid?: string | null;
} | null): Promise<{
    outcome: "stable";
    identity: WhatsAppSelfIdentity;
} | {
    outcome: "unstable";
}>;
/**
 * Return the age (in milliseconds) of the cached WhatsApp web auth state, or null when missing.
 * Helpful for heartbeats/observability to spot stale credentials.
 */
export declare function getWebAuthAgeMs(authDir?: string): number | null;
export declare function logWebSelfId(authDir?: string, runtime?: RuntimeEnv, includeChannelPrefix?: boolean): void;
export declare function pickWebChannel(pref: WebChannel | "auto", authDir?: string): Promise<WebChannel>;
