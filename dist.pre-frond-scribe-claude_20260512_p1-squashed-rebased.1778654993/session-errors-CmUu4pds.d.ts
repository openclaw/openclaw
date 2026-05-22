import { n as RuntimeEnv } from "./runtime-DwtdMXkL.js";
import { r as WhatsAppSelfIdentity } from "./identity-Cj4Vv3Qf.js";

//#region extensions/whatsapp/src/targets-runtime.d.ts
type WebChannel = "web";
declare function assertWebChannel(input: string): asserts input is WebChannel;
declare function isSelfChatMode(selfE164: string | null | undefined, allowFrom?: Array<string | number> | null): boolean;
declare function toWhatsappJid(number: string): string;
declare function toWhatsappJidWithLid(number: string, opts?: JidToE164Options): string;
type JidToE164Options = {
  authDir?: string;
  lidMappingDirs?: string[];
  logMissing?: boolean;
};
type LidLookup = {
  getPNForLID?: (jid: string) => Promise<string | null>;
};
declare function jidToE164(jid: string, opts?: JidToE164Options): string | null;
declare function resolveJidToE164(jid: string | null | undefined, opts?: JidToE164Options & {
  lidLookup?: LidLookup;
}): Promise<string | null>;
declare function markdownToWhatsApp(text: string): string;
//#endregion
//#region extensions/whatsapp/src/creds-files.d.ts
declare function resolveWebCredsPath(authDir: string): string;
declare function resolveWebCredsBackupPath(authDir: string): string;
declare function hasWebCredsSync(authDir: string): boolean;
//#endregion
//#region extensions/whatsapp/src/auth-store.d.ts
declare const WHATSAPP_AUTH_UNSTABLE_CODE = "whatsapp-auth-unstable";
type WhatsAppWebAuthState = "linked" | "not-linked" | "unstable";
declare class WhatsAppAuthUnstableError extends Error {
  readonly code = "whatsapp-auth-unstable";
  constructor(message?: string);
}
declare function resolveDefaultWebAuthDir(): string;
declare const WA_WEB_AUTH_DIR: string;
declare function readCredsJsonRaw(filePath: string): string | null;
declare function restoreCredsFromBackupIfNeeded(authDir: string): Promise<boolean>;
declare function webAuthExists(authDir?: string): Promise<boolean>;
declare function formatWhatsAppWebAuthStatusState(state: WhatsAppWebAuthState): string;
declare function readWebAuthState(authDir?: string): Promise<WhatsAppWebAuthState>;
declare function readWebAuthSnapshot(authDir?: string): Promise<{
  readonly state: WhatsAppWebAuthState;
  readonly authAgeMs: number | null;
  readonly selfId: {
    readonly e164: string | null;
    readonly jid: string | null;
    readonly lid: string | null;
  };
}>;
declare function readWebAuthExistsBestEffort(authDir?: string): Promise<{
  readonly exists: boolean;
  readonly timedOut: boolean;
}>;
declare function readWebAuthExistsForDecision(authDir?: string): Promise<{
  outcome: "stable";
  exists: boolean;
} | {
  outcome: "unstable";
}>;
declare function readWebAuthSnapshotBestEffort(authDir?: string): Promise<{
  readonly linked: boolean;
  readonly timedOut: boolean;
  readonly authAgeMs: number | null;
  readonly selfId: {
    readonly e164: string | null;
    readonly jid: string | null;
    readonly lid: string | null;
  };
}>;
declare function logoutWeb(params: {
  authDir?: string;
  isLegacyAuthDir?: boolean;
  runtime?: RuntimeEnv;
}): Promise<boolean>;
declare function readWebSelfId(authDir?: string): {
  readonly e164: string | null;
  readonly jid: string | null;
  readonly lid: string | null;
};
declare function readWebSelfIdentity(authDir?: string, fallback?: {
  id?: string | null;
  lid?: string | null;
} | null): Promise<WhatsAppSelfIdentity>;
declare function readWebSelfIdentityForDecision(authDir?: string, fallback?: {
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
declare function getWebAuthAgeMs(authDir?: string): number | null;
declare function logWebSelfId(authDir?: string, runtime?: RuntimeEnv, includeChannelPrefix?: boolean): void;
declare function pickWebChannel(pref: WebChannel | "auto", authDir?: string): Promise<WebChannel>;
//#endregion
//#region extensions/whatsapp/src/session-errors.d.ts
declare function getStatusCode(err: unknown): number | undefined;
declare function formatError(err: unknown): string;
//#endregion
export { isSelfChatMode as A, webAuthExists as C, JidToE164Options as D, resolveWebCredsPath as E, toWhatsappJidWithLid as F, markdownToWhatsApp as M, resolveJidToE164 as N, WebChannel as O, toWhatsappJid as P, restoreCredsFromBackupIfNeeded as S, resolveWebCredsBackupPath as T, readWebAuthState as _, WhatsAppAuthUnstableError as a, readWebSelfIdentityForDecision as b, getWebAuthAgeMs as c, pickWebChannel as d, readCredsJsonRaw as f, readWebAuthSnapshotBestEffort as g, readWebAuthSnapshot as h, WHATSAPP_AUTH_UNSTABLE_CODE as i, jidToE164 as j, assertWebChannel as k, logWebSelfId as l, readWebAuthExistsForDecision as m, getStatusCode as n, WhatsAppWebAuthState as o, readWebAuthExistsBestEffort as p, WA_WEB_AUTH_DIR as r, formatWhatsAppWebAuthStatusState as s, formatError as t, logoutWeb as u, readWebSelfId as v, hasWebCredsSync as w, resolveDefaultWebAuthDir as x, readWebSelfIdentity as y };