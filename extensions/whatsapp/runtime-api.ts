// Heavy runtime exports for WhatsApp — loaded lazily by runtime-whatsapp-boundary.ts.
// This module contains full-socket-requiring exports.
export { monitorWebChannel } from "./src/channel.runtime.js";
export { createWaSocket, waitForWaConnection } from "./src/session.js";
export { loginWeb } from "./src/login.js";
export { startWebLoginWithQr, waitForWebLogin } from "./src/login-qr.js";
export { sendMessageWhatsApp, sendPollWhatsApp, sendReactionWhatsApp } from "./src/send.js";
export { runWebHeartbeatOnce } from "./src/auto-reply/heartbeat-runner.js";
export { extractMediaPlaceholder, extractText, monitorWebInbox } from "./src/inbound.js";

/**
 * Stub for handleWhatsAppAction — actual implementation is dispatched through
 * the plugin runtime (`getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction`).
 * This export satisfies the boundary type alias; callers should not use it directly.
 */
export async function handleWhatsAppAction(..._args: unknown[]): Promise<unknown> {
  throw new Error("handleWhatsAppAction must be called via the plugin runtime, not directly");
}
