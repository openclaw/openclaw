import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
export type CliOutboundSendSource = {
    sendMessageWhatsApp: OutboundSendDeps["sendWhatsApp"];
    sendMessageTelegram: OutboundSendDeps["sendTelegram"];
    sendMessageDiscord: OutboundSendDeps["sendDiscord"];
    sendMessageSlack: OutboundSendDeps["sendSlack"];
    sendMessageSignal: OutboundSendDeps["sendSignal"];
    sendMessageIMessage: OutboundSendDeps["sendIMessage"];
};
export declare function createOutboundSendDepsFromCliSource(deps: CliOutboundSendSource): OutboundSendDeps;
