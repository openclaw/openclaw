import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";

export function hasWhatsAppAudioBody(msg: AdmittedWebInboundMessage): boolean {
  return (
    (msg.payload.media?.kind === "audio" ||
      msg.payload.media?.type?.startsWith("audio/") === true) &&
    !msg.payload.body.trim()
  );
}

export async function transcribeWhatsAppAudioMessage(
  cfg: OpenClawConfig,
  msg: AdmittedWebInboundMessage,
  accountId: string | undefined,
): Promise<string | undefined> {
  const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
  const media = msg.payload.media;
  const conversationId = msg.admission.conversation.id;
  return await transcribeFirstAudio({
    ctx: {
      media: [{ path: media?.path, contentType: media?.type, kind: media?.kind ?? undefined }],
      From: conversationId,
      To: msg.platform.recipientJid,
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: conversationId,
      AccountId: accountId,
    },
    cfg,
  });
}
