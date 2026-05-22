import { i as OpenClawConfig$1 } from "./types.openclaw-BlE9q7jU.js";
import { a as GroupToolPolicyConfig } from "./types.tools-rF2K5Ucb.js";
import { n as RuntimeEnv } from "./runtime-B7xbUSXv.js";
import { y as BackoffPolicy } from "./wsl-ClP4Twwp.js";
import { t as getReplyFromConfig } from "./get-reply-DgKAPor1.js";
import { i as WASocket } from "./identity-DBuyTmkF.js";
import { i as WebListenerCloseReason, n as ActiveWebSendOptions, o as WhatsAppSendResult, r as WebInboundMessage } from "./types-DQsd34VK.js";
import { a as waitForWaConnection, u as WhatsAppSocketTimingOptions } from "./login-qr-runtime-B69n4DVz.js";
//#region extensions/whatsapp/src/group-policy.d.ts
type WhatsAppGroupContext = {
  cfg: OpenClawConfig$1;
  accountId?: string | null;
  groupId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};
declare function resolveWhatsAppGroupRequireMention(params: WhatsAppGroupContext): boolean;
declare function resolveWhatsAppGroupToolPolicy(params: WhatsAppGroupContext): GroupToolPolicyConfig | undefined;
//#endregion
//#region extensions/whatsapp/src/reconnect.d.ts
type ReconnectPolicy = BackoffPolicy & {
  maxAttempts: number;
};
//#endregion
//#region extensions/whatsapp/src/auto-reply/types.d.ts
type WebChannelHealthState = "starting" | "healthy" | "stale" | "reconnecting" | "conflict" | "logged-out" | "stopped";
type WebInboundMsg = WebInboundMessage;
type WebChannelStatus = {
  running: boolean;
  connected: boolean;
  reconnectAttempts: number;
  lastConnectedAt?: number | null;
  lastDisconnect?: {
    at: number;
    status?: number;
    error?: string;
    loggedOut?: boolean;
  } | null;
  lastInboundAt?: number | null;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastTransportActivityAt?: number | null;
  lastError?: string | null;
  healthState?: WebChannelHealthState;
};
type WebMonitorTuning = {
  reconnect?: Partial<ReconnectPolicy>;
  socketTiming?: WhatsAppSocketTimingOptions;
  heartbeatSeconds?: number;
  transportTimeoutMs?: number;
  messageTimeoutMs?: number;
  watchdogCheckMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  statusSink?: (status: WebChannelStatus) => void; /** WhatsApp account id. Default: "default". */
  accountId?: string; /** Debounce window (ms) for batching rapid consecutive messages from the same sender. */
  debounceMs?: number;
};
//#endregion
//#region extensions/whatsapp/src/resolve-outbound-target.d.ts
type WhatsAppOutboundTargetResolution = {
  ok: true;
  to: string;
} | {
  ok: false;
  error: Error;
};
declare function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution;
//#endregion
//#region extensions/whatsapp/src/login.d.ts
declare function loginWeb(verbose: boolean, waitForConnection?: typeof waitForWaConnection, runtime?: RuntimeEnv, accountId?: string): Promise<void>;
//#endregion
//#region extensions/whatsapp/src/inbound/monitor.d.ts
type WhatsAppGroupMetadataCacheEntry = {
  subject?: string;
  expires: number;
};
type WhatsAppGroupMetadataCache = Map<string, WhatsAppGroupMetadataCacheEntry>;
type MonitorWebInboxOptions = {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number; /** Keep the global presence unavailable so self-chat sessions do not mute phone pushes. */
  selfChatMode?: boolean; /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean; /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number; /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean; /** Optional shared socket reference so reply closures can follow reconnects. */
  socketRef?: {
    current: WASocket | null;
  }; /** Whether send retries should wait for a reconnect. */
  shouldRetryDisconnect?: () => boolean; /** Reconnect timing for waiting through transient socket replacement gaps. */
  disconnectRetryPolicy?: {
    initialMs: number;
    maxMs: number;
    factor: number;
    jitter: number;
    maxAttempts: number;
  }; /** Abort in-flight reconnect waits when shutdown becomes terminal. */
  disconnectRetryAbortSignal?: AbortSignal; /** Shared group metadata cache used only for inbound metadata fallback after fetch failures. */
  groupMetadataCache?: WhatsAppGroupMetadataCache;
};
declare function attachWebInboxToSocket(options: MonitorWebInboxOptions & {
  sock: WASocket;
}): Promise<{
  readonly sendMessage: (to: string, text: string, mediaBuffer?: Buffer, mediaType?: string, sendOptions?: ActiveWebSendOptions) => Promise<WhatsAppSendResult>;
  readonly sendPoll: (to: string, poll: {
    question: string;
    options: string[];
    maxSelections?: number;
  }) => Promise<WhatsAppSendResult>;
  readonly sendReaction: (chatJid: string, messageId: string, emoji: string, fromMe: boolean, participant?: string) => Promise<WhatsAppSendResult>;
  readonly sendComposingTo: (to: string) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly onClose: Promise<WebListenerCloseReason>;
  readonly signalClose: (reason?: WebListenerCloseReason) => void;
}>;
declare function monitorWebInbox(options: MonitorWebInboxOptions): Promise<{
  readonly sendMessage: (to: string, text: string, mediaBuffer?: Buffer, mediaType?: string, sendOptions?: ActiveWebSendOptions) => Promise<WhatsAppSendResult>;
  readonly sendPoll: (to: string, poll: {
    question: string;
    options: string[];
    maxSelections?: number;
  }) => Promise<WhatsAppSendResult>;
  readonly sendReaction: (chatJid: string, messageId: string, emoji: string, fromMe: boolean, participant?: string) => Promise<WhatsAppSendResult>;
  readonly sendComposingTo: (to: string) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly onClose: Promise<WebListenerCloseReason>;
  readonly signalClose: (reason?: WebListenerCloseReason) => void;
}>;
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor.d.ts
type ReplyResolver = typeof getReplyFromConfig;
declare function monitorWebChannel(verbose: boolean, listenerFactory?: typeof attachWebInboxToSocket | undefined, keepAlive?: boolean, replyResolver?: ReplyResolver, runtime?: RuntimeEnv, abortSignal?: AbortSignal, tuning?: WebMonitorTuning): Promise<void>;
//#endregion
//#region extensions/whatsapp/src/group-intro.d.ts
declare function resolveWhatsAppGroupIntroHint(): string;
//#endregion
//#region extensions/whatsapp/src/runtime-api.d.ts
type OpenClawConfig = OpenClawConfig$1;
//#endregion
export { resolveWhatsAppOutboundTarget as a, WebInboundMsg as c, resolveWhatsAppGroupToolPolicy as d, loginWeb as i, WebMonitorTuning as l, monitorWebChannel as n, WebChannelHealthState as o, monitorWebInbox as r, WebChannelStatus as s, resolveWhatsAppGroupIntroHint as t, resolveWhatsAppGroupRequireMention as u };