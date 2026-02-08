export type ZulipClient = {
  baseUrl: string;
  email: string;
  apiKey: string;
};

export type ZulipRegisterResponse = {
  queue_id: string;
  last_event_id: number;
};

export type ZulipEventsResponse = {
  events?: Array<{ id: number; type: string; message?: ZulipMessage }>;
  result: string;
  msg?: string;
};

export type ZulipUser = {
  user_id: number;
  email?: string;
  delivery_email?: string;
  full_name?: string;
  is_active?: boolean;
  is_bot?: boolean;
};

export type ZulipMessage = {
  id: number;
  type: "private" | "stream";
  content: string;
  content_type?: string;
  sender_email: string;
  sender_full_name?: string;
  sender_id?: number;
  timestamp: number;
  // stream
  stream_id?: number;
  display_recipient?: string;
  subject?: string;
  topic?: string;
  // private
  recipients?: Array<{ email: string; full_name?: string; id?: number }>;
  flags?: string[];
};

export function normalizeZulipBaseUrl(raw: string | undefined | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function withAuth(client: ZulipClient, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const token = Buffer.from(`${client.email}:${client.apiKey}`).toString("base64");
  headers.set("Authorization", `Basic ${token}`);

  // Optional Cloudflare Access Service Token support.
  // If your Zulip is protected by Cloudflare Access, create a Service Token and
  // export these in the gateway environment (e.g. ~/.openclaw/.env):
  // - ZULIP_CF_ACCESS_CLIENT_ID
  // - ZULIP_CF_ACCESS_CLIENT_SECRET
  const cfId = process.env.ZULIP_CF_ACCESS_CLIENT_ID?.trim();
  const cfSecret = process.env.ZULIP_CF_ACCESS_CLIENT_SECRET?.trim();
  if (cfId && cfSecret) {
    headers.set("CF-Access-Client-Id", cfId);
    headers.set("CF-Access-Client-Secret", cfSecret);
  }

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }
  return { ...init, headers };
}

/**
 * Parse a Zulip API response, throwing a friendly error on auth/proxy HTML pages
 * or on Zulip-style {result:"error"} payloads.
 */
export async function parseJsonOrThrow(res: Response): Promise<unknown> {
  const text = await res.text();

  // Zulip API endpoints should return JSON.
  // If we get HTML, it's often an auth/SSO/proxy login page (Cloudflare Access, SSO, etc.),
  // but "non-JSON" can also be an upstream error page (502/503) or a misconfigured base URL.
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const looksLikeHtml =
    /^\s*<!doctype html/i.test(text) ||
    /^\s*<html/i.test(text) ||
    /^\s*<head/i.test(text) ||
    /^\s*<meta\b/i.test(text);

  let payload: Record<string, unknown>;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const snippet = text.trim().slice(0, 240).replace(/\s+/g, " ");

    if (looksLikeHtml) {
      const likelyCause =
        res.status >= 500
          ? "This looks like an upstream/proxy error page (e.g. 502/503 from a reverse proxy, CDN, or load balancer), not a Zulip JSON API response. "
          : "This typically means an auth/SSO/proxy layer is intercepting API requests. ";

      throw new Error(
        "Zulip API error: received HTML instead of JSON from /api. " +
          `HTTP ${res.status} (content-type: ${contentType || "unknown"}). ` +
          likelyCause +
          "If Zulip works in one environment but not another, compare DNS (IPv6 vs IPv4), egress network/proxy, and reverse-proxy timeouts for long-polling (/api/v1/events). " +
          "If applicable, allow bot access to /api/v1/* (service token / bypass policy) or use an internal API base URL. " +
          (snippet ? `Snippet: ${snippet}` : ""),
      );
    }

    throw new Error(
      "Zulip API error: received non-JSON response from /api. " +
        `HTTP ${res.status} (content-type: ${contentType || "unknown"}). ` +
        "This can be caused by a proxy/load balancer error (502/503), a misconfigured base URL, or an auth layer. " +
        (snippet ? `Snippet: ${snippet}` : ""),
    );
  }

  const msgField =
    typeof payload?.msg === "string"
      ? payload.msg
      : typeof payload?.message === "string"
        ? payload.message
        : null;

  if (!res.ok) {
    const msg = msgField ?? `${res.status} ${res.statusText}`;
    throw new Error(`Zulip API error: ${msg}`);
  }

  if (payload?.result && payload.result !== "success") {
    const resultField = typeof payload.result === "string" ? payload.result : "unknown";
    throw new Error(`Zulip API error: ${msgField ?? resultField}`);
  }

  return payload;
}

export async function zulipRegister(
  client: ZulipClient,
  params: {
    eventTypes?: string[];
    allPublicStreams?: boolean;
  } = {},
): Promise<ZulipRegisterResponse> {
  const url = new URL("/api/v1/register", client.baseUrl);
  const body = new URLSearchParams();
  body.set("event_types", JSON.stringify(params.eventTypes ?? ["message"]));
  body.set("apply_markdown", "false");
  body.set("client_gravatar", "false");
  if (typeof params.allPublicStreams === "boolean") {
    body.set("all_public_streams", params.allPublicStreams ? "true" : "false");
  }

  const res = await fetch(url, withAuth(client, { method: "POST", body }));
  const payload = (await parseJsonOrThrow(res)) as ZulipRegisterResponse;
  return payload;
}

export async function zulipGetEvents(
  client: ZulipClient,
  params: {
    queueId: string;
    lastEventId: number;
    timeoutSeconds?: number;
  },
): Promise<ZulipEventsResponse> {
  const url = new URL("/api/v1/events", client.baseUrl);
  url.searchParams.set("queue_id", params.queueId);
  url.searchParams.set("last_event_id", String(params.lastEventId));
  if (typeof params.timeoutSeconds === "number") {
    url.searchParams.set("dont_block", "false");
    url.searchParams.set("timeout", String(Math.max(1, Math.floor(params.timeoutSeconds))));
  }

  const res = await fetch(url, withAuth(client, { method: "GET" }));
  return (await parseJsonOrThrow(res)) as ZulipEventsResponse;
}

export async function zulipGetUsers(client: ZulipClient): Promise<ZulipUser[]> {
  const url = new URL("/api/v1/users", client.baseUrl);
  const res = await fetch(url, withAuth(client, { method: "GET" }));
  const payload = await parseJsonOrThrow(res);
  return Array.isArray(payload?.members) ? (payload.members as ZulipUser[]) : [];
}

export async function zulipSetTypingStatus(
  client: ZulipClient,
  params: { op: "start" | "stop"; to: number[]; type?: "direct" },
): Promise<void> {
  const url = new URL("/api/v1/typing", client.baseUrl);
  const body = new URLSearchParams();
  body.set("type", params.type ?? "direct");
  body.set("op", params.op);
  body.set("to", JSON.stringify(params.to));
  const res = await fetch(url, withAuth(client, { method: "POST", body }));
  await parseJsonOrThrow(res);
}

export async function zulipAddReaction(
  client: ZulipClient,
  params: { messageId: number; emojiName: string },
): Promise<void> {
  const url = new URL(`/api/v1/messages/${params.messageId}/reactions`, client.baseUrl);
  const body = new URLSearchParams();
  body.set("emoji_name", params.emojiName);
  const res = await fetch(url, withAuth(client, { method: "POST", body }));
  await parseJsonOrThrow(res);
}

export async function zulipSendMessage(
  client: ZulipClient,
  params:
    | { type: "stream"; stream: string; topic: string; content: string }
    | { type: "private"; to: Array<string | number>; content: string },
): Promise<{ id: number } | null> {
  const url = new URL("/api/v1/messages", client.baseUrl);
  const body = new URLSearchParams();
  body.set("type", params.type);
  if (params.type === "stream") {
    body.set("to", params.stream);
    body.set("topic", params.topic);
  } else {
    body.set("to", JSON.stringify(params.to));
  }
  body.set("content", params.content);

  const res = await fetch(url, withAuth(client, { method: "POST", body }));
  const payload = await parseJsonOrThrow(res);
  if (typeof payload?.id === "number") {
    return { id: payload.id };
  }
  return null;
}
