import { makeWASocket } from "@whiskeysockets/baileys";
export { getWebAuthAgeMs, logoutWeb, logWebSelfId, pickWebChannel, readWebSelfId, WA_WEB_AUTH_DIR, webAuthExists, } from "./auth-store.js";
/**
 * Create a Baileys socket backed by the multi-file auth store we keep on disk.
 * Consumers can opt into QR printing for interactive login flows.
 */
export declare function createWaSocket(printQr: boolean, verbose: boolean, opts?: {
    authDir?: string;
    onQr?: (qr: string) => void;
}): Promise<ReturnType<typeof makeWASocket>>;
export declare function waitForWaConnection(sock: ReturnType<typeof makeWASocket>): Promise<void>;
export declare function getStatusCode(err: unknown): number | undefined;
export declare function formatError(err: unknown): string;
export declare function newConnectionId(): `${string}-${string}-${string}-${string}-${string}`;
