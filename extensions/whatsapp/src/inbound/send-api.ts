import type { MiscMessageGenerationOptions } from "baileys";
import { readWhatsAppLidToPnMappings } from "../lid-mapping-files.js";
import { classifyWhatsAppJid, encodeWhatsAppJid } from "../whatsapp-jid.js";
import type { WhatsAppOutboundMessageIdentity } from "./outbound-message-cache.js";
import type { AnyMessageContent, WAMessage } from "baileys";
import { resolveWhatsAppDocumentFileName } from "../document-filename.js";
import { addWhatsAppImagePreviewFields } from "../image-preview.js";
import { isWhatsAppNewsletterJid } from "../normalize-target.js";
import { buildQuotedMessageOptions } from "../quoted-message.js";
import type { WhatsAppSocketOperationAdapter } from "../socket-timing.js";
import { toWhatsappJid, toWhatsappJidWithLid } from "../targets-runtime.js";
import {
  addWhatsAppOutboundMentionsToContent,
  type WhatsAppOutboundMentionResolution,
} from "./outbound-mentions.js";
import {
  combineWhatsAppSendResults,
  mergeWhatsAppAcceptedSendError,
  normalizeWhatsAppSendResult,
  rememberWhatsAppAcceptedSend,
  type WhatsAppSendKind,
  type WhatsAppSendResult,
} from "./send-result.js";
import type { ActiveWebSendOptions } from "./types.js";

type StructuredContactSend = {
  displayName: string;
  vcard: string;
};

type StructuredLocationSend = {
  address?: string;
  degreesLatitude: number;
  degreesLongitude: number;
  name?: string;
};

type StructuredStickerSendOptions = {
  mimetype?: string;
};

type WhatsAppOutboundRoute = {
  jid: string;
  identity?: WhatsAppOutboundMessageIdentity;
};

function prepareOutboundIdentity(params: {
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

export function createWebSendApi(params: {
  sock: WhatsAppSocketOperationAdapter;
  defaultAccountId: string;
  resolveOutboundMentions?: (params: {
    jid: string;
    text: string;
  }) => Promise<WhatsAppOutboundMentionResolution> | WhatsAppOutboundMentionResolution;
  // When provided, lets outbound resolve `{phone}@s.whatsapp.net` to `{lid}@lid`
  // via Baileys' lid-mapping-{phone-digits}.json files in the auth dir, so
  // proactive sends to LID-addressed contacts reach the recipient instead of
  // ending up in a sender-only ghost chat (#67378). Defaults to PN-only.
  authDir?: string;
}) {
  const resolveOutboundRoute = (recipient: string): WhatsAppOutboundRoute => {
    const requestedJid = toWhatsappJid(recipient);
    const jid = params.authDir
      ? toWhatsappJidWithLid(recipient, { authDir: params.authDir })
      : requestedJid;
    return {
      jid,
      identity: prepareOutboundIdentity({
        requestedJid,
        routedJid: jid,
        authDir: params.authDir,
      }),
    };
  };
  const resolveMentions = async (
    jid: string,
    text: string,
  ): Promise<WhatsAppOutboundMentionResolution> =>
    params.resolveOutboundMentions
      ? await params.resolveOutboundMentions({ jid, text })
      : { text, mentionedJids: [] };
  const sendForRoute = async (
    route: WhatsAppOutboundRoute,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ): Promise<WAMessage | undefined> => {
    if (route.identity) {
      return await params.sock.sendMessage(route.jid, content, options, route.identity);
    }
    return options
      ? await params.sock.sendMessage(route.jid, content, options)
      : await params.sock.sendMessage(route.jid, content);
  };
  const runAcceptedSend = async (
    kind: WhatsAppSendKind,
    accountId: string,
    send: (
      capture: (result: WAMessage | undefined, kind: WhatsAppSendKind) => void,
    ) => Promise<void>,
  ): Promise<WhatsAppSendResult> => {
    const results: WhatsAppSendResult[] = [];
    try {
      // Baileys resolves only after relay acceptance; capture that fact before any later work.
      await send((result, sendKind) => {
        rememberWhatsAppAcceptedSend({
          accountId,
          result: normalizeWhatsAppSendResult(result, sendKind),
          results,
        });
      });
      return combineWhatsAppSendResults(kind, results);
    } catch (error) {
      throw mergeWhatsAppAcceptedSendError({ error, kind, results });
    }
  };
  const sendStructuredMessage = async (
    to: string,
    content: AnyMessageContent,
    kind: WhatsAppSendKind,
  ): Promise<WhatsAppSendResult> => {
    const route = resolveOutboundRoute(to);
    const jid = route.jid;
    return await runAcceptedSend(kind, params.defaultAccountId, async (capture) => {
      capture(await sendForRoute(route, content), kind);
    });
  };

  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaTypeInput?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<WhatsAppSendResult> => {
      let mediaType = mediaTypeInput;
      const route = resolveOutboundRoute(to);
    const jid = route.jid;
      let payload: AnyMessageContent;
      if (mediaBuffer) {
        mediaType ??= "application/octet-stream";
      }
      const shouldSendAudioText = Boolean(
        mediaBuffer && mediaType?.startsWith("audio/") && text.trim(),
      );
      const resolvedPayloadText = shouldSendAudioText
        ? { text, mentionedJids: [] }
        : await resolveMentions(jid, text);
      if (mediaBuffer && mediaType) {
        const mediaFields = { caption: resolvedPayloadText.text || undefined, mimetype: mediaType };
        if (mediaType.startsWith("image/") && sendOptions?.asDocument !== true) {
          payload = await addWhatsAppImagePreviewFields({
            image: mediaBuffer,
            ...mediaFields,
          });
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/") && sendOptions?.asDocument !== true) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            ...mediaFields,
            ...(gifPlayback ? { gifPlayback: true } : {}),
          };
        } else {
          const fileName = resolveWhatsAppDocumentFileName({
            fileName: sendOptions?.fileName,
            mimetype: mediaType,
          });
          payload = {
            document: mediaBuffer,
            fileName,
            ...mediaFields,
          };
        }
      } else {
        payload = { text: resolvedPayloadText.text };
      }
      payload = addWhatsAppOutboundMentionsToContent(payload, resolvedPayloadText.mentionedJids);
      const quotedOpts = buildQuotedMessageOptions({
        ...sendOptions?.quotedMessageKey,
        messageId: sendOptions?.quotedMessageKey?.id,
        destinationJid: jid,
        requestedJid: toWhatsappJid(to),
      });
      const kind = mediaBuffer ? "media" : "text";
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      return await runAcceptedSend(kind, accountId, async (capture) => {
        const sendPayload = async (content: AnyMessageContent) =>
          await sendForRoute(route, content, quotedOpts);
        capture(await sendPayload(payload), kind);
        if (shouldSendAudioText) {
          const resolvedAudioText = await resolveMentions(jid, text);
          const textPayload = addWhatsAppOutboundMentionsToContent(
            { text: resolvedAudioText.text },
            resolvedAudioText.mentionedJids,
          );
          capture(await sendPayload(textPayload), "text");
        }
      });
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ) =>
      await sendStructuredMessage(
        to,
        {
          poll: {
            name: poll.question,
            values: poll.options,
            selectableCount: poll.maxSelections ?? 1,
          },
        },
        "poll",
      ),
    sendContact: async (to: string, contact: StructuredContactSend) =>
      await sendStructuredMessage(
        to,
        {
          contacts: {
            displayName: contact.displayName,
            contacts: [
              {
                displayName: contact.displayName,
                vcard: contact.vcard,
              },
            ],
          },
        },
        "contact",
      ),
    sendLocation: async (to: string, location: StructuredLocationSend) =>
      await sendStructuredMessage(
        to,
        {
          location: {
            degreesLatitude: location.degreesLatitude,
            degreesLongitude: location.degreesLongitude,
            name: location.name,
            address: location.address,
          },
        },
        "location",
      ),
    sendSticker: async (
      to: string,
      stickerBuffer: Buffer,
      options?: StructuredStickerSendOptions,
    ) =>
      await sendStructuredMessage(
        to,
        {
          sticker: stickerBuffer,
          mimetype: options?.mimetype ?? "image/webp",
        },
        "sticker",
      ),
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<WhatsAppSendResult> => {
      // Resolve DM targets through the same LID-aware path as normal sends so
      // reactions land on the delivered WhatsApp message key.
      const route = resolveOutboundRoute(chatJid);
      const jid = route.jid;
      const result = await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: participant ? toWhatsappJid(participant) : undefined,
          },
        },
      });
      return normalizeWhatsAppSendResult(result, "reaction");
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const route = resolveOutboundRoute(to);
    const jid = route.jid;
      if (isWhatsAppNewsletterJid(jid)) {
        return;
      }
      await params.sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}
