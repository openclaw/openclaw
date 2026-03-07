/**
 * Zulip API Client
 * 
 * Implements the Zulip REST API for sending/receiving messages.
 * API docs: https://zulip.com/api/
 */

export type ZulipClient = {
  baseUrl: string;
  apiBaseUrl: string;
  email: string;
  apiKey: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

export type ZulipUser = {
  user_id: number;
  email: string;
  full_name: string;
  is_bot: boolean;
  bot_type?: number | null;
  avatar_url?: string | null;
  timezone?: string | null;
};

export type ZulipStream = {
  stream_id: number;
  name: string;
  description?: string | null;
  invite_only?: boolean;
};

export type ZulipMessage = {
  id: number;
  sender_id: number;
  sender_email: string;
  sender_full_name: string;
  recipient_id?: number;
  stream_id?: number;
  subject?: string; // topic
  content: string;
  content_type?: string;
  timestamp: number;
  type: "stream" | "private";
  display_recipient: string | ZulipUser[];
  flags?: string[];
};

export type ZulipEventQueue = {
  queue_id: string;
  last_event_id: number;
  event_queue_longpoll_timeout_seconds?: number;
};

export type ZulipEvent = {
  id: number;
  type: string;
  message?: ZulipMessage;
  flags?: string[];
  [key: string]: unknown;
};

export function normalizeZulipBaseUrl(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  // Remove trailing slashes and /api/v1 suffix
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  return withoutTrailing.replace(/\/api\/v1$/i, "");
}

function buildZulipApiUrl(baseUrl: string, path: string): string {
  const normalized = normalizeZulipBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Zulip baseUrl is required");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}/api/v1${suffix}`;
}

async function readZulipError(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as { msg?: string; result?: string } | undefined;
    if (data?.msg) {
      return data.msg;
    }
    return JSON.stringify(data);
  }
  return await res.text();
}

export function createZulipClient(params: {
  baseUrl: string;
  email: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ZulipClient {
  const baseUrl = normalizeZulipBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new Error("Zulip baseUrl is required");
  }
  const apiBaseUrl = `${baseUrl}/api/v1`;
  const email = params.email.trim();
  const apiKey = params.apiKey.trim();
  const fetchImpl = params.fetchImpl ?? fetch;

  // Zulip uses HTTP Basic Auth with email:api_key
  const authHeader = `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}`;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = buildZulipApiUrl(baseUrl, path);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", authHeader);
    
    // For form data, don't set Content-Type (let fetch handle it)
    if (typeof init?.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
    
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readZulipError(res);
      throw new Error(
        `Zulip API ${res.status} ${res.statusText}: ${detail || "unknown error"}`,
      );
    }
    
    const data = (await res.json()) as { result?: string; msg?: string } & T;
    if (data.result === "error") {
      throw new Error(`Zulip API error: ${data.msg || "unknown error"}`);
    }
    return data as T;
  };

  return { baseUrl, apiBaseUrl, email, apiKey, request };
}

// API Methods

export async function fetchZulipMe(client: ZulipClient): Promise<ZulipUser> {
  return await client.request<ZulipUser>("/users/me");
}

export async function fetchZulipUser(
  client: ZulipClient,
  userId: number,
): Promise<{ user: ZulipUser }> {
  return await client.request<{ user: ZulipUser }>(`/users/${userId}`);
}

export async function fetchZulipUserByEmail(
  client: ZulipClient,
  email: string,
): Promise<{ user: ZulipUser }> {
  return await client.request<{ user: ZulipUser }>(
    `/users/${encodeURIComponent(email)}`,
  );
}

export async function fetchZulipStreams(
  client: ZulipClient,
): Promise<{ streams: ZulipStream[] }> {
  return await client.request<{ streams: ZulipStream[] }>("/streams");
}

export async function fetchZulipSubscriptions(
  client: ZulipClient,
): Promise<{ subscriptions: ZulipStream[] }> {
  return await client.request<{ subscriptions: ZulipStream[] }>("/users/me/subscriptions");
}

export async function sendZulipMessage(
  client: ZulipClient,
  params: {
    type: "stream" | "direct";
    to: string | number | number[]; // stream name, user_id, or array of user_ids
    content: string;
    topic?: string; // required for stream messages
  },
): Promise<{ id: number }> {
  const formData = new URLSearchParams();
  formData.append("type", params.type);
  
  if (Array.isArray(params.to)) {
    formData.append("to", JSON.stringify(params.to));
  } else {
    formData.append("to", String(params.to));
  }
  
  formData.append("content", params.content);
  
  if (params.topic) {
    formData.append("topic", params.topic);
  }

  return await client.request<{ id: number }>("/messages", {
    method: "POST",
    body: formData.toString(),
  });
}

export async function sendZulipTyping(
  client: ZulipClient,
  params: {
    op: "start" | "stop";
    to: number[]; // user_ids for DM, or empty for stream
    type?: "direct" | "stream";
    stream_id?: number;
    topic?: string;
  },
): Promise<void> {
  const formData = new URLSearchParams();
  formData.append("op", params.op);
  formData.append("to", JSON.stringify(params.to));
  
  if (params.type) {
    formData.append("type", params.type);
  }
  if (params.stream_id) {
    formData.append("stream_id", String(params.stream_id));
  }
  if (params.topic) {
    formData.append("topic", params.topic);
  }

  await client.request<Record<string, unknown>>("/typing", {
    method: "POST",
    body: formData.toString(),
  });
}

export async function registerZulipEventQueue(
  client: ZulipClient,
  params?: {
    event_types?: string[];
    narrow?: Array<[string, string]>;
    all_public_streams?: boolean;
  },
): Promise<ZulipEventQueue> {
  const formData = new URLSearchParams();
  
  // Subscribe to message events by default
  const eventTypes = params?.event_types ?? ["message"];
  formData.append("event_types", JSON.stringify(eventTypes));
  
  if (params?.narrow) {
    formData.append("narrow", JSON.stringify(params.narrow));
  }
  if (params?.all_public_streams !== undefined) {
    formData.append("all_public_streams", String(params.all_public_streams));
  }

  return await client.request<ZulipEventQueue>("/register", {
    method: "POST",
    body: formData.toString(),
  });
}

export async function getZulipEvents(
  client: ZulipClient,
  params: {
    queue_id: string;
    last_event_id: number;
    dont_block?: boolean;
  },
): Promise<{ events: ZulipEvent[]; queue_id: string }> {
  const searchParams = new URLSearchParams();
  searchParams.append("queue_id", params.queue_id);
  searchParams.append("last_event_id", String(params.last_event_id));
  
  if (params.dont_block) {
    searchParams.append("dont_block", "true");
  }

  return await client.request<{ events: ZulipEvent[]; queue_id: string }>(
    `/events?${searchParams.toString()}`,
  );
}

export async function deleteZulipEventQueue(
  client: ZulipClient,
  queueId: string,
): Promise<void> {
  const formData = new URLSearchParams();
  formData.append("queue_id", queueId);
  
  await client.request<Record<string, unknown>>("/events", {
    method: "DELETE",
    body: formData.toString(),
  });
}

export async function addZulipReaction(
  client: ZulipClient,
  messageId: number,
  emojiName: string,
): Promise<void> {
  const formData = new URLSearchParams();
  formData.append("emoji_name", emojiName);
  
  await client.request<Record<string, unknown>>(`/messages/${messageId}/reactions`, {
    method: "POST",
    body: formData.toString(),
  });
}

export async function uploadZulipFile(
  client: ZulipClient,
  params: {
    buffer: Buffer;
    fileName: string;
  },
): Promise<{ uri: string }> {
  const form = new FormData();
  const blob = new Blob([Uint8Array.from(params.buffer)]);
  form.append("file", blob, params.fileName);

  const url = `${client.apiBaseUrl}/user_uploads`;
  const authHeader = `Basic ${Buffer.from(`${client.email}:${client.apiKey}`).toString("base64")}`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
    },
    body: form,
  });

  if (!res.ok) {
    const detail = await readZulipError(res);
    throw new Error(`Zulip API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
  }

  const data = (await res.json()) as { uri?: string; result?: string; msg?: string };
  if (data.result === "error") {
    throw new Error(`Zulip upload error: ${data.msg || "unknown error"}`);
  }
  if (!data.uri) {
    throw new Error("Zulip file upload failed: no URI returned");
  }
  return { uri: data.uri };
}
