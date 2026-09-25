import { MessageReferenceType, MessageType } from "discord-api-types/v10";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChannelMessage, Message, type Client } from "../internal/discord.js";
import { resolveDiscordMessageStickers } from "./message-forwarded.js";
import { resolveDiscordMessageText } from "./message-text.js";

function shouldHydrateDiscordMessagePayload(message: Message) {
  let currentText;
  try {
    currentText = resolveDiscordMessageText(message, {
      includeForwarded: true,
    });
  } catch {
    return true;
  }
  if (!currentText) {
    return true;
  }
  const hasMentionMetadata =
    (message.mentionedUsers?.length ?? 0) > 0 ||
    (message.mentionedRoles?.length ?? 0) > 0 ||
    message.mentionedEveryone;
  if (hasMentionMetadata) {
    return false;
  }
  return /<@!?\d+>|<@&\d+>|@everyone|@here/u.test(currentText);
}

type ReferencedMessagePayloadState = "complete" | "missing" | "invalid";

function resolveReferencedMessagePayloadState(message: Message): ReferencedMessagePayloadState {
  const reference = message.messageReference;
  if (!reference?.message_id) {
    return "complete";
  }
  if (reference.type != null && reference.type !== MessageReferenceType.Default) {
    return "complete";
  }
  if (message.type != null && message.type !== MessageType.Reply) {
    return "complete";
  }
  const rawData = message.rawData;
  if (!Object.hasOwn(rawData, "referenced_message")) {
    return "missing";
  }
  const referenced = rawData.referenced_message;
  if (referenced == null) {
    return "complete";
  }
  if (typeof referenced !== "object" || referenced.id !== reference.message_id) {
    return "invalid";
  }
  const reply = message.referencedMessage;
  // A matching ID can still carry an empty nested payload; recover the selected
  // message before treating that absence as the user's intended reply context.
  return reply?.author &&
    (resolveDiscordMessageText(reply, { includeForwarded: true }) ||
      reply.attachments.length > 0 ||
      resolveDiscordMessageStickers(reply).length > 0)
    ? "complete"
    : "missing";
}

async function hydrateDiscordReplyReference(params: {
  client: Pick<Client, "rest" | "fetchUser">;
  message: Message;
  messageChannelId: string;
}): Promise<Message> {
  const payloadState = resolveReferencedMessagePayloadState(params.message);
  if (payloadState === "complete") {
    return params.message;
  }
  const reference = params.message.messageReference;
  const referencedMessageId = reference?.message_id;
  if (!referencedMessageId) {
    return params.message;
  }
  const referencedChannelId = reference.channel_id ?? params.messageChannelId;
  try {
    const referenced = await getChannelMessage(
      params.client.rest,
      referencedChannelId,
      referencedMessageId,
    );
    // Discord may omit referenced_message from both Gateway and REST reply payloads.
    // Attach the canonical referenced fetch so downstream reply context stays bounded.
    return new Message(params.client, {
      ...params.message.rawData,
      referenced_message: referenced,
    });
  } catch (err) {
    logVerbose(
      `discord: failed to hydrate referenced message ${referencedMessageId}: ${String(err)}`,
    );
    if (payloadState === "invalid") {
      // A mismatched nested payload must never become reply context for another message.
      return new Message(params.client, {
        ...params.message.rawData,
        referenced_message: null,
      });
    }
    return params.message;
  }
}

type DiscordMessageHydrationOutcome =
  | { kind: "authoritative"; message: Message }
  | { kind: "unavailable"; message: Message };

export async function hydrateDiscordMessageIfNeeded(params: {
  client: Pick<Client, "rest" | "fetchUser">;
  message: Message;
  messageChannelId: string;
}): Promise<DiscordMessageHydrationOutcome> {
  let hydrated = params.message;
  if (shouldHydrateDiscordMessagePayload(params.message)) {
    try {
      const fetched = await getChannelMessage(
        params.client.rest,
        params.messageChannelId,
        params.message.id,
      );
      logVerbose(`discord: hydrated inbound payload via REST for ${params.message.id}`);
      hydrated = new Message(params.client, {
        ...(params.message.partial ? {} : params.message.rawData),
        ...fetched,
      });
    } catch (err) {
      logVerbose(`discord: failed to hydrate message ${params.message.id}: ${String(err)}`);
      return { kind: "unavailable", message: params.message };
    }
  }
  return {
    kind: "authoritative",
    message: await hydrateDiscordReplyReference({
      client: params.client,
      message: hydrated,
      messageChannelId: params.messageChannelId,
    }),
  };
}
