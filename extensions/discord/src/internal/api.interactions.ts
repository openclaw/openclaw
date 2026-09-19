import { Routes } from "discord-api-types/v10";
import { normalizeDiscordMessageId } from "./api.messages.js";
import type { RequestQuery } from "./rest-scheduler.js";
import type { RequestClient, RequestData } from "./rest.js";

function normalizeDiscordWebhookMessageId(messageId: string): string {
  const normalized = messageId.trim();
  return normalized === "@original" ? normalized : normalizeDiscordMessageId(normalized);
}

export async function createInteractionCallback(
  rest: RequestClient,
  interactionId: string,
  token: string,
  body: unknown,
): Promise<unknown> {
  return await rest.post(Routes.interactionCallback(interactionId, token), { body });
}

export async function editWebhookMessage(
  rest: RequestClient,
  applicationId: string,
  token: string,
  messageId: string,
  data: RequestData,
  query?: RequestQuery,
): Promise<unknown> {
  const route = Routes.webhookMessage(
    applicationId,
    token,
    normalizeDiscordWebhookMessageId(messageId),
  );
  return query ? await rest.patch(route, data, query) : await rest.patch(route, data);
}

export async function deleteWebhookMessage(
  rest: RequestClient,
  applicationId: string,
  token: string,
  messageId: string,
): Promise<unknown> {
  return await rest.delete(
    Routes.webhookMessage(applicationId, token, normalizeDiscordWebhookMessageId(messageId)),
  );
}

export async function getWebhookMessage(
  rest: RequestClient,
  applicationId: string,
  token: string,
  messageId: string,
): Promise<unknown> {
  return await rest.get(
    Routes.webhookMessage(applicationId, token, normalizeDiscordWebhookMessageId(messageId)),
  );
}

export async function createWebhookMessage(
  rest: RequestClient,
  applicationId: string,
  token: string,
  data: RequestData,
  query?: RequestQuery,
): Promise<unknown> {
  return await rest.post(Routes.webhook(applicationId, token), data, query);
}
