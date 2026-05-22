import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { chunkText } from "openclaw/plugin-sdk/reply-chunking";
import { createWhatsAppOutboundBase } from "./outbound-base.js";
import { normalizeWhatsAppPayloadTextPreservingIndentation } from "./outbound-text.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";
import { getWhatsAppRuntime } from "./runtime.js";

const loadWhatsAppSend = createLazyRuntimeModule(() => import("./send.js"));

function normalizeWhatsAppChannelSendText(text: string | undefined): string {
  const normalized = normalizeWhatsAppPayloadTextPreservingIndentation(text);
  return normalized.trim() ? normalized : "";
}

export const whatsappChannelRuntimeOutbound = createWhatsAppOutboundBase({
  chunker: chunkText,
  sendMessageWhatsApp: async (to, text, options) =>
    await (
      await loadWhatsAppSend()
    ).sendMessageWhatsApp(to, text, {
      ...options,
      preserveLeadingWhitespace: true,
    }),
  sendPollWhatsApp: async (to, poll, options) =>
    await (await loadWhatsAppSend()).sendPollWhatsApp(to, poll, options),
  shouldLogVerbose: () => getWhatsAppRuntime().logging.shouldLogVerbose(),
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  normalizeText: normalizeWhatsAppChannelSendText,
});
