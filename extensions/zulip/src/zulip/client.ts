/**
 * Zulip REST API client using fetch with Basic auth.
 */

export type ZulipClient = {
  baseUrl: string;
  botEmail: string;
  botApiKey: string;
  authHeader: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  requestForm: <T>(path: string, params: Record<string, string>) => Promise<T>;
};

export type ZulipUser = {
  user_id: number;
  email: string;
  full_name: string;
  is_bot: boolean;
  avatar_url?: string;
};

export type ZulipStream = {
  stream_id: number;
  name: string;
  description?: string;
};

export type ZulipMessage = {
  id: number;
  sender_id: number;
  sender_email: string;
  sender_full_name: string;
  is_bot?: boolean;
  type: "stream" | "private";
  stream_id?: number;
  display_recipient: string | Array<{ id: number; email: string; full_name: string }>;
  subject: string; // topic
  content: string;
  timestamp: number;
  flags?: string[];
};

export type ZulipRegisterResponse = {
  queue_id: string;
  last_event_id: number;
  zulip_version?: string;
};

export type ZulipEvent = {
  id: number;
  type: string;
  message?: ZulipMessage;
  flags?: string[];
};

export type ZulipEventsResponse = {
  events: ZulipEvent[];
  result: string;
  msg?: string;
};

export type ZulipSendMessageResponse = {
  id: number;
  result: string;
  msg?: string;
};

export type ZulipUpdateMessageResponse = {
  result: string;
  msg?: string;
};

export type ZulipUploadResponse = {
  uri: string;
  result: string;
  msg?: string;
};

export type ZulipSubmessageEvent = {
  id: number;
  type: "submessage";
  message_id: number;
  submessage_id: number;
  sender_id: number;
  msg_type: string;
  content: string;
};

export function normalizeZulipBaseUrl(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function buildBasicAuth(email: string, apiKey: string): string {
  const encoded = Buffer.from(`${email}:${apiKey}`).toString("base64");
  return `Basic ${encoded}`;
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
  botEmail: string;
  botApiKey: string;
  fetchImpl?: typeof fetch;
}): ZulipClient {
  const baseUrl = normalizeZulipBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new Error("Zulip baseUrl is required");
  }
  const botEmail = params.botEmail.trim();
  const botApiKey = params.botApiKey.trim();
  const authHeader = buildBasicAuth(botEmail, botApiKey);
  const fetchImpl = params.fetchImpl ?? fetch;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = `${baseUrl}/api/v1${path}`;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", authHeader);
    if (typeof init?.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readZulipError(res);
      throw new Error(`Zulip API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
    }
    return (await res.json()) as T;
  };

  const requestForm = async <T>(path: string, formParams: Record<string, string>): Promise<T> => {
    const url = `${baseUrl}/api/v1${path}`;
    const body = new URLSearchParams(formParams);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const detail = await readZulipError(res);
      throw new Error(`Zulip API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
    }
    return (await res.json()) as T;
  };

  return { baseUrl, botEmail, botApiKey, authHeader, request, requestForm };
}

/** Get the bot's own user profile. */
export async function fetchZulipMe(client: ZulipClient): Promise<ZulipUser> {
  const data = await client.request<{ result: string; zulip_version?: string } & ZulipUser>(
    "/users/me",
  );
  return data;
}

/** Register a long-poll event queue for message events. */
export async function registerZulipQueue(
  client: ZulipClient,
  eventTypes: string[] = ["message"],
): Promise<ZulipRegisterResponse> {
  return await client.requestForm<ZulipRegisterResponse>("/register", {
    event_types: JSON.stringify(eventTypes),
    apply_markdown: "false",
    all_public_streams: "true",
  });
}

/** Get events from the queue (long-poll). */
export async function getZulipEvents(
  client: ZulipClient,
  queueId: string,
  lastEventId: number,
  signal?: AbortSignal,
): Promise<ZulipEventsResponse> {
  const url = `${client.baseUrl}/api/v1/events?queue_id=${encodeURIComponent(queueId)}&last_event_id=${lastEventId}`;
  const res = await fetch(url, {
    headers: { Authorization: client.authHeader },
    signal,
  });
  if (!res.ok) {
    const detail = await readZulipError(res);
    throw new Error(`Zulip events ${res.status}: ${detail}`);
  }
  return (await res.json()) as ZulipEventsResponse;
}

/** Send a stream message. */
export async function sendZulipStreamMessage(
  client: ZulipClient,
  params: { stream: string; topic: string; content: string },
): Promise<ZulipSendMessageResponse> {
  return await client.requestForm<ZulipSendMessageResponse>("/messages", {
    type: "stream",
    to: params.stream,
    topic: params.topic,
    content: params.content,
  });
}

/** Send a stream message with an attached widget (ocform). */
export async function sendZulipStreamMessageWithWidget(
  client: ZulipClient,
  params: {
    stream: string;
    topic: string;
    content: string;
    widgetContent: string;
  },
): Promise<ZulipSendMessageResponse> {
  return await client.requestForm<ZulipSendMessageResponse>("/messages", {
    type: "stream",
    to: params.stream,
    topic: params.topic,
    content: params.content,
    widget_content: params.widgetContent,
  });
}

/** Send a direct (private) message. */
export async function sendZulipDirectMessage(
  client: ZulipClient,
  params: { to: number[]; content: string },
): Promise<ZulipSendMessageResponse> {
  return await client.requestForm<ZulipSendMessageResponse>("/messages", {
    type: "direct",
    to: JSON.stringify(params.to),
    content: params.content,
  });
}

/** Send a direct message with an attached widget (ocform). */
export async function sendZulipDirectMessageWithWidget(
  client: ZulipClient,
  params: { to: number[]; content: string; widgetContent: string },
): Promise<ZulipSendMessageResponse> {
  return await client.requestForm<ZulipSendMessageResponse>("/messages", {
    type: "direct",
    to: JSON.stringify(params.to),
    content: params.content,
    widget_content: params.widgetContent,
  });
}

/**
 * Update an existing message (edit content and/or move topic).
 *
 * Uses PATCH /messages/{message_id} with form-encoded params.
 * Zulip supports propagating topic changes with propagate_mode.
 */
export async function updateZulipMessage(
  client: ZulipClient,
  params: {
    messageId: number;
    content?: string;
    topic?: string;
    propagateMode?: "change_one" | "change_later" | "change_all";
  },
): Promise<ZulipUpdateMessageResponse> {
  const formParams: Record<string, string> = {};
  if (params.content !== undefined) {
    formParams.content = params.content;
  }
  if (params.topic !== undefined) {
    formParams.topic = params.topic;
  }
  if (params.propagateMode !== undefined) {
    formParams.propagate_mode = params.propagateMode;
  }
  const body = new URLSearchParams(formParams);

  const res = await fetch(`${client.baseUrl}/api/v1/messages/${params.messageId}`, {
    method: "PATCH",
    headers: {
      Authorization: client.authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await readZulipError(res);
    throw new Error(`Zulip update message ${res.status}: ${detail}`);
  }
  return (await res.json()) as ZulipUpdateMessageResponse;
}

/** Send a typing indicator. */
export async function sendZulipTyping(
  client: ZulipClient,
  params: { op: "start" | "stop"; streamId?: number; topic?: string; to?: number[] },
): Promise<void> {
  const formParams: Record<string, string> = { op: params.op };
  if (params.streamId !== undefined && params.topic) {
    formParams.type = "stream";
    formParams.stream_id = String(params.streamId);
    formParams.topic = params.topic;
  } else if (params.to) {
    formParams.type = "direct";
    formParams.to = JSON.stringify(params.to);
  }
  await client.requestForm<{ result: string }>("/typing", formParams);
}

/** Add an emoji reaction to a message. */
export async function addZulipReaction(
  client: ZulipClient,
  params: { messageId: number; emojiName: string; emojiCode?: string; reactionType?: string },
): Promise<void> {
  const formParams: Record<string, string> = {
    emoji_name: params.emojiName,
  };
  if (params.emojiCode) {
    formParams.emoji_code = params.emojiCode;
  }
  if (params.reactionType) {
    formParams.reaction_type = params.reactionType;
  }
  await client.requestForm<{ result: string }>(
    `/messages/${params.messageId}/reactions`,
    formParams,
  );
}

/** Remove an emoji reaction from a message. */
export async function removeZulipReaction(
  client: ZulipClient,
  params: { messageId: number; emojiName: string; emojiCode?: string; reactionType?: string },
): Promise<void> {
  const qs = new URLSearchParams({ emoji_name: params.emojiName });
  if (params.emojiCode) {
    qs.set("emoji_code", params.emojiCode);
  }
  if (params.reactionType) {
    qs.set("reaction_type", params.reactionType);
  }
  await client.request<{ result: string }>(`/messages/${params.messageId}/reactions?${qs}`, {
    method: "DELETE",
  });
}

/** Upload a file and return the server URI. */
export async function uploadZulipFile(
  client: ZulipClient,
  params: { buffer: Buffer; fileName: string; contentType?: string },
): Promise<string> {
  const form = new FormData();
  const bytes = Uint8Array.from(params.buffer);
  const blob = params.contentType
    ? new Blob([bytes], { type: params.contentType })
    : new Blob([bytes]);
  form.append("filename", blob, params.fileName || "upload");

  const res = await fetch(`${client.baseUrl}/api/v1/user_uploads`, {
    method: "POST",
    headers: { Authorization: client.authHeader },
    body: form,
  });
  if (!res.ok) {
    const detail = await readZulipError(res);
    throw new Error(`Zulip upload ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as ZulipUploadResponse;
  return data.uri;
}

/** Get stream ID by name. */
export async function getZulipStreamId(client: ZulipClient, streamName: string): Promise<number> {
  const data = await client.request<{ stream_id: number; result: string }>(
    `/get_stream_id?stream=${encodeURIComponent(streamName)}`,
  );
  return data.stream_id;
}

export type ZulipMessagesResponse = {
  messages: ZulipMessage[];
  result: string;
  msg?: string;
};

/**
 * Fetch recent messages (for replay on reconnect).
 * Uses anchor=newest and num_before to get recent messages.
 */
export async function fetchZulipMessages(
  client: ZulipClient,
  params: {
    anchor?: string | number;
    numBefore?: number;
    numAfter?: number;
    narrow?: Array<{ operator: string; operand: string | number }>;
  } = {},
): Promise<ZulipMessage[]> {
  const anchor = params.anchor ?? "newest";
  const numBefore = params.numBefore ?? 50;
  const numAfter = params.numAfter ?? 0;
  const narrow = params.narrow ?? [];

  const queryParams = new URLSearchParams({
    anchor: String(anchor),
    num_before: String(numBefore),
    num_after: String(numAfter),
    narrow: JSON.stringify(narrow),
    apply_markdown: "false",
  });

  const data = await client.request<ZulipMessagesResponse>(`/messages?${queryParams.toString()}`);
  return data.messages;
}
