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

export async function getGuildMember(
  rest: RequestClient,
  guildId: string,
  userId: string,
): Promise<APIGuildMember> {
  return (await rest.get(Routes.guildMember(guildId, userId))) as APIGuildMember;
}

export async function getGuildVoiceState(
  rest: RequestClient,
  guildId: string,
  userId: string,
): Promise<APIVoiceState> {
  return (await rest.get(Routes.guildVoiceState(guildId, userId))) as APIVoiceState;
}

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
