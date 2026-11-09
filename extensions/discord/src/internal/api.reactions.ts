import { Routes } from "discord-api-types/v10";
import { normalizeDiscordMessageId } from "./api.messages.js";
import type { RequestQuery } from "./rest-scheduler.js";
import type { RequestClient } from "./rest.js";

function ownReactionMutation(method: "put" | "delete") {
  return async (
    rest: RequestClient,
    channelId: string,
    messageId: string,
    encodedEmoji: string,
  ): Promise<void> => {
    await rest[method](
      Routes.channelMessageOwnReaction(
        channelId,
        normalizeDiscordMessageId(messageId),
        encodedEmoji,
      ),
    );
  };
}

export const createOwnMessageReaction = ownReactionMutation("put");
export const deleteOwnMessageReaction = ownReactionMutation("delete");

export async function listMessageReactionUsers(
  rest: RequestClient,
  channelId: string,
  messageId: string,
  encodedEmoji: string,
  query?: RequestQuery,
): Promise<Array<{ id: string; username?: string; discriminator?: string }>> {
  return (await rest.get(
    Routes.channelMessageReaction(channelId, normalizeDiscordMessageId(messageId), encodedEmoji),
    query,
  )) as Array<{
    id: string;
    username?: string;
    discriminator?: string;
  }>;
}
