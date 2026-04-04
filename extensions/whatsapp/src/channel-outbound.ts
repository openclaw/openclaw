import { chunkText } from "openclaw/plugin-sdk/reply-chunking";
import { createWhatsAppOutboundBase } from "./outbound-base.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";
import { getWhatsAppRuntime } from "./runtime.js";

type WhatsAppSendRuntime = typeof import("./send.runtime.js");

let whatsappSendRuntimePromise: Promise<WhatsAppSendRuntime> | null = null;

async function loadWhatsAppSendRuntime() {
  whatsappSendRuntimePromise ??= import("./send.runtime.js");
  return await whatsappSendRuntimePromise;
}

export function normalizeWhatsAppPayloadText(text: string | undefined): string {
  return (text ?? "").replace(/^(?:[ \t]*\r?\n)+/, "");
}

export const whatsappChannelOutbound = {
  ...createWhatsAppOutboundBase({
    chunker: chunkText,
    sendMessageWhatsApp: async (...args) =>
      (await loadWhatsAppSendRuntime()).sendMessageWhatsApp(...args),
    sendPollWhatsApp: async (...args) =>
      (await loadWhatsAppSendRuntime()).sendPollWhatsApp(...args),
    shouldLogVerbose: () => getWhatsAppRuntime().logging.shouldLogVerbose(),
    resolveTarget: ({ to, allowFrom, mode }) =>
      resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  }),
  normalizePayload: ({ payload }: { payload: { text?: string } }) => ({
    ...payload,
    text: normalizeWhatsAppPayloadText(payload.text),
  }),
};
