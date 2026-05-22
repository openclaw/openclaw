import { n as RuntimeEnv } from "./runtime-DRy59NVK.js";
import { i as WHATSAPP_AUTH_UNSTABLE_CODE } from "./session-errors-BHZAn1t_.js";
import { a as makeWASocket } from "./identity-BaWpjx8n.js";

//#region extensions/whatsapp/src/socket-timing.d.ts
type WhatsAppSocketTimingOptions = {
  keepAliveIntervalMs?: number;
  connectTimeoutMs?: number;
  defaultQueryTimeoutMs?: number;
};
//#endregion
//#region extensions/whatsapp/src/creds-persistence.d.ts
type CredsQueueWaitResult = "drained" | "timed_out";
declare function writeCredsJsonAtomically(authDir: string, creds: unknown): Promise<void>;
declare function waitForCredsSaveQueue(authDir?: string): Promise<void>;
declare function waitForCredsSaveQueueWithTimeout(authDir: string, timeoutMs?: number): Promise<CredsQueueWaitResult>;
//#endregion
//#region extensions/whatsapp/src/session.d.ts
/**
 * Create a Baileys socket backed by the multi-file auth store we keep on disk.
 * Consumers can opt into QR printing for interactive login flows.
 */
declare function createWaSocket(printQr: boolean, verbose: boolean, opts?: {
  authDir?: string;
  onQr?: (qr: string) => void;
} & WhatsAppSocketTimingOptions): Promise<ReturnType<typeof makeWASocket>>;
declare function waitForWaConnection(sock: ReturnType<typeof makeWASocket>): Promise<void>;
declare function newConnectionId(): `${string}-${string}-${string}-${string}-${string}`;
//#endregion
//#region extensions/whatsapp/src/login-qr.d.ts
type StartWebLoginWithQrResult = {
  qrDataUrl?: string;
  message: string;
  connected?: boolean;
  code?: typeof WHATSAPP_AUTH_UNSTABLE_CODE;
};
declare function startWebLoginWithQr$1(opts?: {
  verbose?: boolean;
  timeoutMs?: number;
  force?: boolean;
  accountId?: string;
  runtime?: RuntimeEnv;
}): Promise<StartWebLoginWithQrResult>;
declare function waitForWebLogin$1(opts?: {
  timeoutMs?: number;
  runtime?: RuntimeEnv;
  accountId?: string;
  currentQrDataUrl?: string;
}): Promise<{
  connected: boolean;
  message: string;
  qrDataUrl?: string;
}>;
//#endregion
//#region extensions/whatsapp/login-qr-runtime.d.ts
type StartWebLoginWithQr = typeof startWebLoginWithQr$1;
type WaitForWebLogin = typeof waitForWebLogin$1;
declare function startWebLoginWithQr(...args: Parameters<StartWebLoginWithQr>): ReturnType<StartWebLoginWithQr>;
declare function waitForWebLogin(...args: Parameters<WaitForWebLogin>): ReturnType<WaitForWebLogin>;
//#endregion
export { waitForWaConnection as a, waitForCredsSaveQueueWithTimeout as c, newConnectionId as i, writeCredsJsonAtomically as l, waitForWebLogin as n, CredsQueueWaitResult as o, createWaSocket as r, waitForCredsSaveQueue as s, startWebLoginWithQr as t, WhatsAppSocketTimingOptions as u };