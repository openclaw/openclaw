import { makeWASocket } from "./session.runtime.js";
import { type WhatsAppSocketTimingOptions } from "./socket-timing.js";
export { formatError, getStatusCode } from "./session-errors.js";
export { getWebAuthAgeMs, logoutWeb, logWebSelfId, pickWebChannel, readWebAuthSnapshot, readWebAuthState, readWebAuthExistsBestEffort, readWebAuthExistsForDecision, readWebAuthSnapshotBestEffort, readWebSelfIdentityForDecision, readWebSelfId, WHATSAPP_AUTH_UNSTABLE_CODE, WhatsAppAuthUnstableError, type WhatsAppWebAuthState, WA_WEB_AUTH_DIR, webAuthExists, } from "./auth-store.js";
export { waitForCredsSaveQueue, waitForCredsSaveQueueWithTimeout, writeCredsJsonAtomically, } from "./creds-persistence.js";
export type { CredsQueueWaitResult } from "./creds-persistence.js";
/**
 * Create a Baileys socket backed by the multi-file auth store we keep on disk.
 * Consumers can opt into QR printing for interactive login flows.
 */
export declare function createWaSocket(printQr: boolean, verbose: boolean, opts?: {
    authDir?: string;
    onQr?: (qr: string) => void;
} & WhatsAppSocketTimingOptions): Promise<ReturnType<typeof makeWASocket>>;
export declare function waitForWaConnection(sock: ReturnType<typeof makeWASocket>): Promise<void>;
export declare function newConnectionId(): `${string}-${string}-${string}-${string}-${string}`;
