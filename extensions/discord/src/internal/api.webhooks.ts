import { Routes } from "discord-api-types/v10";
import type { RequestData } from "./rest-body.js";
import type { RequestClient } from "./rest.js";

export async function createChannelWebhook(
  rest: RequestClient,
  channelId: string,
  data: RequestData,
): Promise<{ id?: string; token?: string }> {
  return (await rest.post(Routes.channelWebhooks(channelId), data)) as {
    id?: string;
    token?: string;
  };
}
