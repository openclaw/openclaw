// Whatsapp plugin module records metadata for accepted native sends.
import type { proto, WAMessage } from "baileys";
import { readWhatsAppLidToPnMappings } from "../lid-mapping-files.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import { classifyWhatsAppJid, encodeWhatsAppJid } from "../whatsapp-jid.js";
import { rememberRecentOutboundMessage } from "./dedupe.js";
import { extractText } from "./extract.js";
export type WhatsAppOutboundMessageIdentity = {
  remoteE164?: string;
  remoteJids?: string[];
};

export function prepareWhatsAppOutboundIdentity(params: {
  requestedJid: string;
  routedJid: string;
  authDir?: string;
}): WhatsAppOutboundMessageIdentity | undefined {
  const requested = classifyWhatsAppJid(params.requestedJid);
  if (requested.kind !== "pn" && requested.kind !== "lid") {
    return undefined;
  }

  let remoteE164 = requested.kind === "pn" ? `+${requested.user}` : undefined;
  const remoteJids = new Set([params.requestedJid, params.routedJid]);
  if (requested.kind === "lid" && params.authDir) {
    const mappings = readWhatsAppLidToPnMappings({
      lid: requested.user,
      mappingDirs: [params.authDir],
    });
    const mappedE164 = mappings.length === 1 ? mappings[0] : undefined;
    if (mappedE164) {
      remoteE164 = mappedE164;
      remoteJids.add(
        encodeWhatsAppJid(
          mappedE164.slice(1),
          requested.server === "hosted.lid" ? "hosted" : "s.whatsapp.net",
        ),
      );
    }
  }
  return { remoteE164, remoteJids: [...remoteJids] };
}

export function createWhatsAppOutboundMessageRecorder(params: {
  accountId: string;
  rememberBaileysMessage: (
    remoteJid: string,
    messageId: string,
    message: proto.IMessage | null | undefined,
  ) => void;
}) {
  const remember = (
    remoteJid: string,
    result: WAMessage | undefined,
    identity?: WhatsAppOutboundMessageIdentity,
  ) => {
    const messageId = result?.key.id ?? "";
    if (!messageId) {
      return;
    }
    rememberRecentOutboundMessage({
      accountId: params.accountId,
      remoteJid,
      messageId,
    });
    const message = result?.message;
    params.rememberBaileysMessage(remoteJid, messageId, message);
    // Baileys derives the participant for fromMe quotes from its own userJid.
    // Retain only the facts needed to avoid the cache-miss fromMe=false fallback.
    cacheInboundMessageMeta(params.accountId, remoteJid, messageId, {
      fromMe: true,
      remoteE164: identity?.remoteE164,
      remoteJids: identity?.remoteJids,
      body: extractText(message ?? undefined),
    });
  };

  const trackLateAccepted = (
    jid: string,
    promise: Promise<WAMessage | undefined>,
    identity?: WhatsAppOutboundMessageIdentity,
  ) => {
    // The local send has failed terminally, but Baileys may still deliver it.
    // Track a late message id only to suppress the resulting self-echo.
    void promise.then(
      (result) => {
        remember(jid, result, identity);
      },
      () => {},
    );
  };

  return { remember, trackLateAccepted } as const;
}
