import {
  Routes,
  type APIChannel,
  type APIMessage,
  type APIThreadMember,
} from "discord-api-types/v10";
import type { RequestData } from "./rest-body.js";
import type { RequestClient } from "./rest.js";

export function normalizeDiscordMessageId(messageId: string): string {
  const normalized = messageId.trim();
  if (!/^[0-9]+$/u.test(normalized)) {
    throw new Error("Invalid Discord message ID. Expected decimal digits.");
  }
  return normalized;
}

export async function getChannel(rest: RequestClient, channelId: string): Promise<APIChannel> {
  return (await rest.get(Routes.channel(channelId))) as APIChannel;
}

export async function getThreadMember(
  rest: RequestClient,
  threadId: string,
  userId: string,
): Promise<APIThreadMember> {
  return (await rest.get(Routes.threadMembers(threadId, userId))) as APIThreadMember;
}

export async function getChannelMessage(
  rest: RequestClient,
  channelId: string,
  messageId: string,
): Promise<APIMessage> {
  return (await rest.get(
    Routes.channelMessage(channelId, normalizeDiscordMessageId(messageId)),
  )) as APIMessage;
}

export async function editChannelMessage(
  rest: RequestClient,
  channelId: string,
  messageId: string,
  data: RequestData,
): Promise<APIMessage> {
  return (await rest.patch(
    Routes.channelMessage(channelId, normalizeDiscordMessageId(messageId)),
    data,
  )) as APIMessage;
}

function messageMutation(
  method: "put" | "delete",
  route: (channelId: string, messageId: string) => string,
) {
  return async (rest: RequestClient, channelId: string, messageId: string): Promise<void> => {
    await rest[method](route(channelId, normalizeDiscordMessageId(messageId)));
  };
}

export const deleteChannelMessage = messageMutation("delete", Routes.channelMessage);
export const pinChannelMessage = messageMutation("put", Routes.channelPin);
export const unpinChannelMessage = messageMutation("delete", Routes.channelPin);

export async function createThread<T extends object = APIChannel>(
  rest: RequestClient,
  channelId: string,
  data: RequestData,
  messageId?: string,
): Promise<T> {
  const route =
    messageId === undefined
      ? Routes.threads(channelId)
      : Routes.threads(channelId, normalizeDiscordMessageId(messageId));
  return (await rest.post(route, data)) as T;
}
