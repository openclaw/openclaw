import { i as getDefaultLocalRoots, n as LocalMediaAccessErrorCode, p as optimizeImageToPng, t as LocalMediaAccessError } from "../../local-media-access-hHraV_MM.js";
import { i as optimizeImageToJpeg, n as loadWebMedia, r as loadWebMediaRaw, t as WebMediaResult } from "../../web-media-CnY09WN8.js";
import { n as PluginRuntime } from "../../types-6GKVZ6OQ.js";
import { n as NormalizedLocation } from "../../location-g7MFWOWb.js";
import { i as stripHeartbeatToken, n as HEARTBEAT_PROMPT } from "../../heartbeat-QgHBqScQ.js";
import { n as SILENT_REPLY_TOKEN, t as HEARTBEAT_TOKEN } from "../../tokens-Cj5Mv3u0.js";
import { a as sendReactionWhatsApp, i as sendPollWhatsApp, n as whatsAppActionRuntime, o as sendTypingWhatsApp, r as sendMessageWhatsApp, t as handleWhatsAppAction } from "../../action-runtime-A3FTmEF8.js";
import { t as DEFAULT_WEB_MEDIA_BYTES } from "../../constants-DxHyZMx6.js";
import { i as loginWeb, l as WebMonitorTuning, n as monitorWebChannel, r as monitorWebInbox, s as WebChannelStatus } from "../../runtime-api-Cbt-4PSz.js";
import { C as webAuthExists, E as resolveWebCredsPath, S as restoreCredsFromBackupIfNeeded, T as resolveWebCredsBackupPath, _ as readWebAuthState, a as WhatsAppAuthUnstableError, b as readWebSelfIdentityForDecision, c as getWebAuthAgeMs, d as pickWebChannel, f as readCredsJsonRaw, g as readWebAuthSnapshotBestEffort, h as readWebAuthSnapshot, i as WHATSAPP_AUTH_UNSTABLE_CODE, l as logWebSelfId, m as readWebAuthExistsForDecision, n as getStatusCode, o as WhatsAppWebAuthState, p as readWebAuthExistsBestEffort, r as WA_WEB_AUTH_DIR, s as formatWhatsAppWebAuthStatusState, t as formatError, u as logoutWeb, v as readWebSelfId, w as hasWebCredsSync, x as resolveDefaultWebAuthDir, y as readWebSelfIdentity } from "../../session-errors-ZzbFyjdr.js";
import { l as proto } from "../../identity-DBuyTmkF.js";
import { a as WhatsAppStructuredContactContext, i as WebListenerCloseReason, n as ActiveWebSendOptions, r as WebInboundMessage, t as ActiveWebListener } from "../../types-DQsd34VK.js";
import { a as waitForWaConnection, c as waitForCredsSaveQueueWithTimeout, i as newConnectionId, l as writeCredsJsonAtomically, n as waitForWebLogin, o as CredsQueueWaitResult, r as createWaSocket, s as waitForCredsSaveQueue, t as startWebLoginWithQr } from "../../login-qr-runtime-B69n4DVz.js";
import { n as resolveWebAccountId, t as getActiveWebListener } from "../../active-listener-CP-SAhG6.js";
import { t as createWhatsAppLoginTool } from "../../agent-tools-login-4h8PAfZc.js";

//#region extensions/whatsapp/src/inbound/dedupe.d.ts
declare function resetWebInboundDedupe(): void;
//#endregion
//#region extensions/whatsapp/src/inbound/extract.d.ts
declare function extractText(rawMessage: proto.IMessage | undefined): string | undefined;
declare function extractMediaPlaceholder(rawMessage: proto.IMessage | undefined): string | undefined;
declare function extractContactContext(rawMessage: proto.IMessage | undefined): WhatsAppStructuredContactContext | undefined;
declare function extractLocationData(rawMessage: proto.IMessage | undefined): NormalizedLocation | null;
//#endregion
//#region extensions/whatsapp/src/runtime.d.ts
declare const setWhatsAppRuntime: (next: PluginRuntime) => void, getWhatsAppRuntime: () => PluginRuntime;
//#endregion
export { type ActiveWebListener, type ActiveWebSendOptions, type CredsQueueWaitResult, DEFAULT_WEB_MEDIA_BYTES, HEARTBEAT_PROMPT, HEARTBEAT_TOKEN, LocalMediaAccessError, type LocalMediaAccessErrorCode, SILENT_REPLY_TOKEN, WA_WEB_AUTH_DIR, WHATSAPP_AUTH_UNSTABLE_CODE, type WebChannelStatus, type WebInboundMessage, type WebListenerCloseReason, type WebMediaResult, type WebMonitorTuning, WhatsAppAuthUnstableError, type WhatsAppWebAuthState, createWaSocket, createWhatsAppLoginTool, extractContactContext, extractLocationData, extractMediaPlaceholder, extractText, formatError, formatWhatsAppWebAuthStatusState, getActiveWebListener, getDefaultLocalRoots, getStatusCode, getWebAuthAgeMs, handleWhatsAppAction, hasWebCredsSync, loadWebMedia, loadWebMediaRaw, logWebSelfId, loginWeb, logoutWeb, monitorWebChannel, monitorWebInbox, newConnectionId, optimizeImageToJpeg, optimizeImageToPng, pickWebChannel, readCredsJsonRaw, readWebAuthExistsBestEffort, readWebAuthExistsForDecision, readWebAuthSnapshot, readWebAuthSnapshotBestEffort, readWebAuthState, readWebSelfId, readWebSelfIdentity, readWebSelfIdentityForDecision, resetWebInboundDedupe, resolveDefaultWebAuthDir, resolveWebAccountId, resolveWebCredsBackupPath, resolveWebCredsPath, restoreCredsFromBackupIfNeeded, sendMessageWhatsApp, sendPollWhatsApp, sendReactionWhatsApp, sendTypingWhatsApp, setWhatsAppRuntime, startWebLoginWithQr, stripHeartbeatToken, waitForCredsSaveQueue, waitForCredsSaveQueueWithTimeout, waitForWaConnection, waitForWebLogin, webAuthExists, whatsAppActionRuntime, writeCredsJsonAtomically };