import type { sendMessageWhatsApp } from "../channels/web/index.js";
import type { sendMessageDiscord } from "../discord/send.js";
import type { sendMessageIMessage } from "../imessage/send.js";
import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import type { sendMessageSignal } from "../signal/send.js";
import type { sendMessageSlack } from "../slack/send.js";
import type { sendMessageTelegram } from "../telegram/send.js";
export type CliDeps = {
    sendMessageWhatsApp: typeof sendMessageWhatsApp;
    sendMessageTelegram: typeof sendMessageTelegram;
    sendMessageDiscord: typeof sendMessageDiscord;
    sendMessageSlack: typeof sendMessageSlack;
    sendMessageSignal: typeof sendMessageSignal;
    sendMessageIMessage: typeof sendMessageIMessage;
};
export declare function createDefaultDeps(): CliDeps;
export declare function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps;
export { logWebSelfId } from "../web/auth-store.js";
