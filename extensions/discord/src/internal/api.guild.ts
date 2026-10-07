import {
  Routes,
  type APIGuild,
  type APIGuildMember,
  type APIVoiceState,
  type RESTGetAPIGuildEmojisResult,
} from "discord-api-types/v10";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { RequestClient } from "./rest.js";

const discordGuildEmojiListSchema = Type.Array(
  Type.Object(
    {
      id: Type.Union([Type.String(), Type.Null()]),
      name: Type.Union([Type.String(), Type.Null()]),
      animated: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
  ),
);

export async function getGuild(rest: RequestClient, guildId: string): Promise<APIGuild> {
  return (await rest.get(Routes.guild(guildId))) as APIGuild;
}

function guildUserRead<T extends object>(route: (guildId: string, userId: string) => string) {
  return async (rest: RequestClient, guildId: string, userId: string): Promise<T> =>
    (await rest.get(route(guildId, userId))) as T;
}

export const getGuildMember = guildUserRead<APIGuildMember>(Routes.guildMember);
export const getGuildVoiceState = guildUserRead<APIVoiceState>(Routes.guildVoiceState);

export async function listGuildEmojis(
  rest: RequestClient,
  guildId: string,
): Promise<RESTGetAPIGuildEmojisResult> {
  const emojis = await rest.get(Routes.guildEmojis(guildId));
  if (!Check(discordGuildEmojiListSchema, emojis)) {
    throw new Error("Invalid Discord guild emoji response.");
  }
  return emojis;
}
