// Viber REST API client

import type { ViberAccountInfo, ViberApiResponse, ViberSendMessageParams } from "./types.js";

const VIBER_API_BASE = "https://chatapi.viber.com/pa";

async function viberRequest<T>(
  token: string,
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${VIBER_API_BASE}/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Viber-Auth-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Viber API error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<T>;
}

export async function setWebhook(
  token: string,
  url: string,
  eventTypes?: string[],
  signal?: AbortSignal,
): Promise<ViberApiResponse> {
  const body: Record<string, unknown> = { url };
  if (eventTypes) {
    body.event_types = eventTypes;
  }
  return viberRequest<ViberApiResponse>(token, "set_webhook", body, signal);
}

export async function removeWebhook(
  token: string,
  signal?: AbortSignal,
): Promise<ViberApiResponse> {
  return viberRequest<ViberApiResponse>(token, "set_webhook", { url: "" }, signal);
}

export async function sendMessage(
  token: string,
  params: ViberSendMessageParams,
  signal?: AbortSignal,
): Promise<ViberApiResponse> {
  return viberRequest<ViberApiResponse>(
    token,
    "send_message",
    params as unknown as Record<string, unknown>,
    signal,
  );
}

export async function getAccountInfo(
  token: string,
  signal?: AbortSignal,
): Promise<ViberAccountInfo> {
  return viberRequest<ViberAccountInfo>(token, "get_account_info", {}, signal);
}
