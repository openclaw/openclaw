import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import type { ResolvedGoHighLevelAccount } from "./accounts.js";
import type { GHLContact, GHLConversation, GHLSendMessageResponse } from "./types.js";

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

function buildHeaders(account: ResolvedGoHighLevelAccount): Record<string, string> {
  if (!account.apiKey) {
    throw new Error("GoHighLevel API key is not configured");
  }
  return {
    Authorization: `Bearer ${account.apiKey}`,
    Version: GHL_API_VERSION,
    "Content-Type": "application/json",
  };
}

async function fetchJson<T>(
  account: ResolvedGoHighLevelAccount,
  url: string,
  init: RequestInit,
): Promise<T> {
  const headers = buildHeaders(account);
  const { response: res } = await fetchWithSsrFGuard({
    url,
    init: {
      ...init,
      headers: {
        ...headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GHL API ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Send a message via GHL Conversations API. */
export async function sendGHLMessage(params: {
  account: ResolvedGoHighLevelAccount;
  conversationId: string;
  message: string;
  messageType?: string;
}): Promise<GHLSendMessageResponse> {
  const { account, conversationId, message, messageType } = params;
  const url = `${GHL_API_BASE}/conversations/messages`;
  return await fetchJson<GHLSendMessageResponse>(account, url, {
    method: "POST",
    body: JSON.stringify({
      type: messageType ?? "SMS",
      contactId: conversationId,
      message,
    }),
  });
}

/** Retrieve a contact by ID. */
export async function getGHLContact(params: {
  account: ResolvedGoHighLevelAccount;
  contactId: string;
}): Promise<GHLContact> {
  const { account, contactId } = params;
  const url = `${GHL_API_BASE}/contacts/${contactId}`;
  const result = await fetchJson<{ contact?: GHLContact }>(account, url, { method: "GET" });
  return result.contact ?? {};
}

/** Retrieve a conversation by ID. */
export async function getGHLConversation(params: {
  account: ResolvedGoHighLevelAccount;
  conversationId: string;
}): Promise<GHLConversation> {
  const { account, conversationId } = params;
  const url = `${GHL_API_BASE}/conversations/${conversationId}`;
  const result = await fetchJson<{ conversation?: GHLConversation }>(account, url, {
    method: "GET",
  });
  return result.conversation ?? {};
}

/** Add a tag to a GHL contact. */
export async function addGHLContactTag(params: {
  account: ResolvedGoHighLevelAccount;
  contactId: string;
  tag: string;
}): Promise<void> {
  const { account, contactId, tag } = params;
  const url = `${GHL_API_BASE}/contacts/${contactId}/tags`;
  await fetchJson<{ tags?: string[] }>(account, url, {
    method: "POST",
    body: JSON.stringify({ tags: [tag] }),
  });
}

/** Probe the GHL API to verify credentials are valid. */
export async function probeGoHighLevel(account: ResolvedGoHighLevelAccount): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  try {
    if (!account.apiKey) {
      return { ok: false, error: "no API key configured" };
    }
    const url = `${GHL_API_BASE}/locations/${account.locationId ?? "unknown"}`;
    const headers = buildHeaders(account);
    const { response: res } = await fetchWithSsrFGuard({
      url,
      init: { method: "GET", headers },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text || res.statusText };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
