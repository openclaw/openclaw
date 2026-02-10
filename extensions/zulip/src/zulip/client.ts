export type ZulipClient = {
  baseUrl: string;
  authHeader: string;
  fetchImpl: typeof fetch;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

export type ZulipApiResponse = {
  result: "success" | "error";
  msg: string;
  code?: string;
  [key: string]: unknown;
};

export type ZulipUser = {
  id: string;
  email?: string | null;
  full_name?: string | null;
  is_admin?: boolean | null;
};

export type ZulipPresenceEntry = {
  status?: "active" | "idle" | string;
  timestamp?: number;
  client?: string | null;
  [key: string]: unknown;
};

export type ZulipPresenceMap = Record<string, ZulipPresenceEntry>;

export type ZulipServerSettings = ZulipApiResponse & Record<string, unknown>;

export type ZulipRealmUpdate = Record<string, string | number | boolean>;

export type ZulipStream = {
  id: string;
  name?: string | null;
  description?: string | null;
};

export type ZulipSubscription = {
  stream_id?: number;
  name?: string;
  description?: string | null;
  email_address?: string | null;
  invite_only?: boolean;
  is_web_public?: boolean;
};

export type ZulipMessage = {
  id: string;
  sender_id?: string | null;
  sender_email?: string | null;
  sender_full_name?: string | null;
  content?: string | null;
  timestamp?: number | null;
  type?: "stream" | "private" | string | null;
  stream_id?: string | null;
  display_recipient?: string | Array<{ id: number; email: string; full_name: string }> | null;
  subject?: string | null;
  recipient_id?: string | null;
};

export function normalizeZulipBaseUrl(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function buildZulipApiUrl(baseUrl: string, path: string): string {
  const normalized = normalizeZulipBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Zulip baseUrl is required");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}/api/v1${suffix}`;
}

function resolveRetryAfterMs(res: Response): number | undefined {
  const retryAfter = res.headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds)) {
    return Math.max(0, seconds) * 1000;
  }
  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readZulipError(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as ZulipApiResponse | undefined;
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
  const email = params.email?.trim();
  const apiKey = params.apiKey?.trim();
  if (!email || !apiKey) {
    throw new Error("Zulip email + apiKey are required");
  }
  const authHeader = Buffer.from(`${email}:${apiKey}`).toString("base64");
  const fetchImpl = params.fetchImpl ?? fetch;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = buildZulipApiUrl(baseUrl, path);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Basic ${authHeader}`);
    if (init?.body && !headers.has("Content-Type") && typeof init.body === "string") {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readZulipError(res);
      const error = new Error(
        `Zulip API ${res.status} ${res.statusText}: ${detail || "unknown error"}`,
      ) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    return (await res.json()) as T;
  };

  return { baseUrl, authHeader, fetchImpl, request };
}

function assertSuccess(payload: ZulipApiResponse, context: string): void {
  if (payload.result === "success") {
    return;
  }
  throw new Error(`${context}: ${payload.msg || "unknown error"}`);
}

export async function zulipRequestWithRetry<T>(
  client: ZulipClient,
  path: string,
  init?: RequestInit,
  options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryStatuses?: number[];
    rateLimitDelayMs?: number;
  },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 30000;
  const retryStatuses = new Set(options?.retryStatuses ?? [429, 502, 503, 504]);
  const rateLimitDelayMs = options?.rateLimitDelayMs ?? baseDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const url = buildZulipApiUrl(client.baseUrl, path);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Basic ${client.authHeader}`);
    if (init?.body && !headers.has("Content-Type") && typeof init.body === "string") {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
    const res = await client.fetchImpl(url, { ...init, headers });
    if (res.ok) {
      return (await res.json()) as T;
    }

    const status = res.status;
    const retryAfterMs = resolveRetryAfterMs(res);
    const detail = await readZulipError(res);
    const error = new Error(
      `Zulip API ${status} ${res.statusText}: ${detail || "unknown error"}`,
    ) as Error & { status?: number; retryAfterMs?: number };
    error.status = status;
    error.retryAfterMs = retryAfterMs;

    if (!retryStatuses.has(status) || attempt >= maxRetries) {
      throw error;
    }

    const base = status === 429 ? rateLimitDelayMs : baseDelayMs;
    const backoff = Math.min(maxDelayMs, base * 2 ** attempt);
    const waitMs = retryAfterMs && retryAfterMs > 0 ? Math.min(maxDelayMs, retryAfterMs) : backoff;
    await sleep(waitMs);
  }

  throw new Error("Zulip API request failed after retries");
}

export async function fetchZulipMe(client: ZulipClient): Promise<ZulipUser> {
  const payload = await client.request<
    ZulipApiResponse & {
      user_id?: number;
      email?: string;
      full_name?: string;
      is_admin?: boolean;
    }
  >("/users/me");
  assertSuccess(payload, "Zulip /users/me failed");
  return {
    id: String(payload.user_id ?? ""),
    email: payload.email ?? null,
    full_name: payload.full_name ?? null,
    is_admin: payload.is_admin ?? null,
  };
}

export async function fetchZulipUser(client: ZulipClient, userId: string): Promise<ZulipUser> {
  const payload = await client.request<
    ZulipApiResponse & { user?: { user_id: number; email?: string; full_name?: string } }
  >(`/users/${userId}`);
  assertSuccess(payload, "Zulip /users/{id} failed");
  const user = payload.user;
  return {
    id: String(user?.user_id ?? userId),
    email: user?.email ?? null,
    full_name: user?.full_name ?? null,
  };
}

export async function fetchZulipMemberInfo(
  client: ZulipClient,
  userId?: string | null,
): Promise<ZulipUser> {
  const trimmed = userId?.trim();
  if (!trimmed || trimmed.toLowerCase() === "me") {
    return await fetchZulipMe(client);
  }
  return await fetchZulipUser(client, trimmed);
}

export async function fetchZulipStream(
  client: ZulipClient,
  streamId: string,
): Promise<ZulipStream> {
  const payload = await client.request<
    ZulipApiResponse & { stream?: { stream_id: number; name?: string; description?: string } }
  >(`/streams/${streamId}`);
  assertSuccess(payload, "Zulip /streams/{id} failed");
  const stream = payload.stream;
  return {
    id: String(stream?.stream_id ?? streamId),
    name: stream?.name ?? null,
    description: stream?.description ?? null,
  };
}

export async function registerZulipQueue(
  client: ZulipClient,
  params: {
    eventTypes?: string[];
    streams?: string[];
  },
): Promise<{ queueId: string; lastEventId: number }> {
  const body = new URLSearchParams();
  const eventTypes = params.eventTypes ?? ["message"];
  body.set("event_types", JSON.stringify(eventTypes));
  body.set("event_queue_longpoll_timeout_seconds", "90");
  if (params.streams && params.streams.length > 0 && !params.streams.includes("*")) {
    // Zulip expects legacy array format for narrow filters.
    const narrow = params.streams.map((stream) => ["stream", stream]);
    body.set("narrow", JSON.stringify(narrow));
  }
  if (params.streams?.includes("*")) {
    body.set("all_public_streams", "true");
  }

  const payload = await client.request<
    ZulipApiResponse & { queue_id?: string; last_event_id?: number }
  >("/register", { method: "POST", body: body.toString() });
  assertSuccess(payload, "Zulip /register failed");
  if (!payload.queue_id) {
    throw new Error("Zulip /register missing queue_id");
  }
  return {
    queueId: payload.queue_id,
    lastEventId: payload.last_event_id ?? -1,
  };
}

export async function getZulipEvents(
  client: ZulipClient,
  params: {
    queueId: string;
    lastEventId: number;
    timeoutMs?: number;
  },
): Promise<
  ZulipApiResponse & { events?: Array<{ id: number; type: string; message?: ZulipMessage }> }
> {
  const qs = new URLSearchParams({
    queue_id: params.queueId,
    last_event_id: String(params.lastEventId),
    dont_block: "false",
  });
  const controller = new AbortController();
  const timeoutMs = params.timeoutMs ?? 90000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs + 15000);
  try {
    return await client.request<
      ZulipApiResponse & { events?: Array<{ id: number; type: string; message?: ZulipMessage }> }
    >(`/events?${qs.toString()}`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function getZulipEventsWithRetry(
  client: ZulipClient,
  params: {
    queueId: string;
    lastEventId: number;
    timeoutMs?: number;
    retryBaseDelayMs?: number;
  },
): Promise<
  ZulipApiResponse & { events?: Array<{ id: number; type: string; message?: ZulipMessage }> }
> {
  const qs = new URLSearchParams({
    queue_id: params.queueId,
    last_event_id: String(params.lastEventId),
    dont_block: "false",
  });
  const controller = new AbortController();
  const timeoutMs = params.timeoutMs ?? 90000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs + 15000);
  try {
    return await zulipRequestWithRetry<
      ZulipApiResponse & { events?: Array<{ id: number; type: string; message?: ZulipMessage }> }
    >(
      client,
      `/events?${qs.toString()}`,
      { signal: controller.signal },
      { baseDelayMs: params.retryBaseDelayMs },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function deleteZulipQueue(client: ZulipClient, queueId: string): Promise<void> {
  if (!queueId) {
    return;
  }
  try {
    const payload = await client.request<ZulipApiResponse>(`/events?queue_id=${queueId}`, {
      method: "DELETE",
    });
    assertSuccess(payload, "Zulip delete event queue failed");
  } catch {
    // ignore cleanup errors
  }
}

export async function sendZulipStreamMessage(
  client: ZulipClient,
  params: {
    stream: string;
    topic: string;
    content: string;
  },
): Promise<{ id?: number }> {
  const body = new URLSearchParams({
    type: "stream",
    to: params.stream,
    topic: params.topic,
    content: params.content,
  });
  const payload = await zulipRequestWithRetry<ZulipApiResponse & { id?: number }>(
    client,
    "/messages",
    {
      method: "POST",
      body: body.toString(),
    },
  );
  assertSuccess(payload, "Zulip stream send failed");
  return { id: payload.id };
}

export async function sendZulipPrivateMessage(
  client: ZulipClient,
  params: {
    to: string | string[];
    content: string;
  },
): Promise<{ id?: number }> {
  const recipients = Array.isArray(params.to) ? params.to : [params.to];
  const body = new URLSearchParams({
    type: "private",
    to: JSON.stringify(recipients),
    content: params.content,
  });
  const payload = await zulipRequestWithRetry<ZulipApiResponse & { id?: number }>(
    client,
    "/messages",
    {
      method: "POST",
      body: body.toString(),
    },
  );
  assertSuccess(payload, "Zulip private send failed");
  return { id: payload.id };
}

export async function uploadZulipFile(
  client: ZulipClient,
  filePath: string,
): Promise<{ url: string }> {
  const filename = filePath.split("/").pop() || "upload.bin";
  const buffer = await (await import("node:fs/promises")).readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  const payload = await zulipRequestWithRetry<ZulipApiResponse & { uri?: string }>(
    client,
    "/user_uploads",
    {
      method: "POST",
      body: form,
    },
  );
  assertSuccess(payload, "Zulip file upload failed");
  if (!payload.uri) {
    throw new Error("Zulip file upload missing uri");
  }
  const url = payload.uri.startsWith("/") ? `${client.baseUrl}${payload.uri}` : payload.uri;
  return { url };
}

export async function sendZulipTyping(
  client: ZulipClient,
  params: {
    op: "start" | "stop";
  } & (
    | { type: "stream"; streamId: number | string; topic: string }
    | { type: "direct"; to: number[] }
  ),
): Promise<void> {
  const body = new URLSearchParams();
  body.set("op", params.op);
  body.set("type", params.type);
  if (params.type === "stream") {
    body.set("stream_id", String(params.streamId));
    body.set("topic", params.topic);
  } else {
    body.set("to", JSON.stringify(params.to));
  }
  await client.request("/typing", {
    method: "POST",
    body: body.toString(),
  });
}

export async function fetchZulipSubscriptions(
  client: ZulipClient,
  params: { includeAllPublic?: boolean } = {},
): Promise<ZulipSubscription[]> {
  const qs = new URLSearchParams();
  if (params.includeAllPublic) {
    qs.set("include_all_public_streams", "true");
  }
  const suffix = qs.toString();
  const payload = await client.request<ZulipApiResponse & { subscriptions?: ZulipSubscription[] }>(
    `/users/me/subscriptions${suffix ? `?${suffix}` : ""}`,
  );
  assertSuccess(payload, "Zulip /users/me/subscriptions failed");
  return payload.subscriptions ?? [];
}

export async function fetchZulipStreams(client: ZulipClient): Promise<ZulipStream[]> {
  const payload = await client.request<
    ZulipApiResponse & {
      streams?: Array<{ stream_id: number; name?: string; description?: string }>;
    }
  >("/streams");
  assertSuccess(payload, "Zulip /streams failed");
  return (payload.streams ?? []).map((stream) => ({
    id: String(stream.stream_id),
    name: stream.name ?? null,
    description: stream.description ?? null,
  }));
}

export async function resolveZulipStreamId(
  client: ZulipClient,
  streamIdOrName: string,
): Promise<string> {
  // The SDK normalizes channelId params to "stream:NAME" format (via normalizeZulipMessagingTarget)
  // before passing to the plugin. Strip the prefix so we can match against actual stream names.
  const raw = streamIdOrName
    .trim()
    .replace(/^stream:/i, "")
    .trim();
  const trimmed = raw;
  // If it's already a numeric ID, return it
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  // Otherwise, look up the stream by name
  const subscriptions = await fetchZulipSubscriptions(client, { includeAllPublic: true });
  const found = subscriptions.find((sub) => sub.name?.toLowerCase() === trimmed.toLowerCase());
  if (found?.stream_id) {
    return String(found.stream_id);
  }
  // Fall back to fetching all streams
  const streams = await fetchZulipStreams(client);
  const foundStream = streams.find(
    (stream) => stream.name?.toLowerCase() === trimmed.toLowerCase(),
  );
  if (foundStream) {
    return foundStream.id;
  }
  throw new Error(`Zulip stream not found: ${streamIdOrName}`);
}

export async function subscribeZulipStream(client: ZulipClient, stream: string): Promise<void> {
  const body = new URLSearchParams({
    subscriptions: JSON.stringify([{ name: stream }]),
  });
  const payload = await client.request<ZulipApiResponse>("/users/me/subscriptions", {
    method: "POST",
    body: body.toString(),
  });
  assertSuccess(payload, "Zulip stream subscribe failed");
}

export async function inviteZulipUsersToStream(
  client: ZulipClient,
  params: {
    stream: string;
    principals: Array<string | number>;
  },
): Promise<void> {
  const body = new URLSearchParams({
    subscriptions: JSON.stringify([{ name: params.stream }]),
    principals: JSON.stringify(params.principals),
  });
  const payload = await client.request<ZulipApiResponse>("/users/me/subscriptions", {
    method: "POST",
    body: body.toString(),
  });
  assertSuccess(payload, "Zulip stream invite failed");
}

export async function createZulipStream(
  client: ZulipClient,
  params: {
    name: string;
    description?: string;
    principals?: Array<string | number>;
    announce?: boolean;
    inviteOnly?: boolean;
    isWebPublic?: boolean;
    isDefaultStream?: boolean;
    historyPublicToSubscribers?: boolean;
  },
): Promise<void> {
  const subscriptions: Array<{ name: string; description?: string }> = [
    {
      name: params.name,
      ...(params.description ? { description: params.description } : {}),
    },
  ];
  const body = new URLSearchParams({
    subscriptions: JSON.stringify(subscriptions),
  });
  if (params.principals && params.principals.length > 0) {
    body.set("principals", JSON.stringify(params.principals));
  }
  if (params.announce !== undefined) {
    body.set("announce", String(params.announce));
  }
  if (params.inviteOnly !== undefined) {
    body.set("invite_only", String(params.inviteOnly));
  }
  if (params.isWebPublic !== undefined) {
    body.set("is_web_public", String(params.isWebPublic));
  }
  if (params.isDefaultStream !== undefined) {
    body.set("is_default_stream", String(params.isDefaultStream));
  }
  if (params.historyPublicToSubscribers !== undefined) {
    body.set("history_public_to_subscribers", String(params.historyPublicToSubscribers));
  }
  const payload = await client.request<ZulipApiResponse>("/users/me/subscriptions", {
    method: "POST",
    body: body.toString(),
  });
  assertSuccess(payload, "Zulip stream create failed");
}

export async function updateZulipStream(
  client: ZulipClient,
  params: {
    streamId: string;
    description?: string;
    newName?: string;
    isPrivate?: boolean;
    isWebPublic?: boolean;
    historyPublicToSubscribers?: boolean;
    isDefaultStream?: boolean;
  },
): Promise<void> {
  const body = new URLSearchParams();
  if (params.description !== undefined) {
    body.set("description", params.description);
  }
  if (params.newName !== undefined) {
    body.set("new_name", params.newName);
  }
  if (params.isPrivate !== undefined) {
    body.set("is_private", String(params.isPrivate));
  }
  if (params.isWebPublic !== undefined) {
    body.set("is_web_public", String(params.isWebPublic));
  }
  if (params.historyPublicToSubscribers !== undefined) {
    body.set("history_public_to_subscribers", String(params.historyPublicToSubscribers));
  }
  if (params.isDefaultStream !== undefined) {
    body.set("is_default_stream", String(params.isDefaultStream));
  }
  const payload = await client.request<ZulipApiResponse>(`/streams/${params.streamId}` as const, {
    method: "PATCH",
    body: body.toString(),
  });
  assertSuccess(payload, "Zulip stream update failed");
}

export async function deleteZulipStream(client: ZulipClient, streamId: string): Promise<void> {
  const payload = await client.request<ZulipApiResponse>(`/streams/${streamId}` as const, {
    method: "DELETE",
  });
  assertSuccess(payload, "Zulip stream delete failed");
}

export async function addZulipReaction(
  client: ZulipClient,
  params: {
    messageId: string;
    emojiName: string;
    emojiCode?: string;
    reactionType?: string;
  },
): Promise<void> {
  const body = new URLSearchParams({
    emoji_name: params.emojiName,
  });
  if (params.emojiCode) {
    body.set("emoji_code", params.emojiCode);
  }
  if (params.reactionType) {
    body.set("reaction_type", params.reactionType);
  }
  const payload = await zulipRequestWithRetry<ZulipApiResponse>(
    client,
    `/messages/${params.messageId}/reactions`,
    { method: "POST", body: body.toString() },
  );
  assertSuccess(payload, "Zulip add reaction failed");
}

export async function removeZulipReaction(
  client: ZulipClient,
  params: {
    messageId: string;
    emojiName?: string;
    emojiCode?: string;
    reactionType?: string;
  },
): Promise<void> {
  const qs = new URLSearchParams();
  if (params.emojiName) {
    qs.set("emoji_name", params.emojiName);
  }
  if (params.emojiCode) {
    qs.set("emoji_code", params.emojiCode);
  }
  if (params.reactionType) {
    qs.set("reaction_type", params.reactionType);
  }
  const suffix = qs.toString();
  const payload = await zulipRequestWithRetry<ZulipApiResponse>(
    client,
    `/messages/${params.messageId}/reactions${suffix ? `?${suffix}` : ""}`,
    { method: "DELETE" },
  );
  assertSuccess(payload, "Zulip remove reaction failed");
}

export async function editZulipMessage(
  client: ZulipClient,
  params: {
    messageId: string;
    content: string;
  },
): Promise<void> {
  const body = new URLSearchParams({
    content: params.content,
  });
  const payload = await client.request<ZulipApiResponse>(`/messages/${params.messageId}`, {
    method: "PATCH",
    body: body.toString(),
  });
  assertSuccess(payload, "Zulip edit message failed");
}

export async function deleteZulipMessage(
  client: ZulipClient,
  params: {
    messageId: string;
  },
): Promise<void> {
  const payload = await client.request<ZulipApiResponse>(`/messages/${params.messageId}`, {
    method: "DELETE",
  });
  assertSuccess(payload, "Zulip delete message failed");
}

export async function updateZulipMessageFlag(
  client: ZulipClient,
  params: {
    messageId: string | number;
    flag: "starred";
    op: "add" | "remove";
  },
): Promise<void> {
  // Convert messageId to integer
  const messageIdInt =
    typeof params.messageId === "number" ? params.messageId : parseInt(params.messageId, 10);
  if (isNaN(messageIdInt)) {
    throw new Error(`Invalid messageId: ${params.messageId}`);
  }
  const body = new URLSearchParams({
    messages: JSON.stringify([messageIdInt]),
    flag: params.flag,
    op: params.op,
  });
  const payload = await client.request<ZulipApiResponse>("/messages/flags", {
    method: "POST",
    body: body.toString(),
  });
  assertSuccess(payload, "Zulip update message flags failed");
}

export async function updateZulipMessageTopic(
  client: ZulipClient,
  params: {
    messageId: string;
    topic: string;
    propagateMode?: "change_one" | "change_all";
  },
): Promise<void> {
  const body = new URLSearchParams({
    topic: params.topic,
    propagate_mode: params.propagateMode ?? "change_all",
  });
  const payload = await client.request<ZulipApiResponse>(`/messages/${params.messageId}`, {
    method: "PATCH",
    body: body.toString(),
  });
  assertSuccess(payload, "Zulip update message topic failed");
}

export async function fetchZulipMessages(
  client: ZulipClient,
  params: {
    stream: string;
    topic?: string;
    limit?: number;
  },
): Promise<ZulipMessage[]> {
  const limit = Math.min(Math.max(1, params.limit ?? 50), 1000);
  const narrow = [{ operator: "stream", operand: params.stream } as Record<string, unknown>];
  if (params.topic) {
    narrow.push({ operator: "topic", operand: params.topic });
  }
  const qs = new URLSearchParams({
    anchor: "newest",
    num_before: String(limit),
    num_after: "0",
    narrow: JSON.stringify(narrow),
  });
  const payload = await client.request<ZulipApiResponse & { messages?: ZulipMessage[] }>(
    `/messages?${qs.toString()}`,
  );
  assertSuccess(payload, "Zulip /messages failed");
  return payload.messages ?? [];
}

export async function searchZulipMessages(
  client: ZulipClient,
  params: {
    query: string;
    stream?: string;
    topic?: string;
    limit?: number;
  },
): Promise<ZulipMessage[]> {
  const limit = Math.min(Math.max(1, params.limit ?? 50), 1000);
  const narrow: Array<Record<string, unknown>> = [{ operator: "search", operand: params.query }];
  if (params.stream) {
    narrow.push({ operator: "stream", operand: params.stream });
  }
  if (params.topic) {
    narrow.push({ operator: "topic", operand: params.topic });
  }
  const qs = new URLSearchParams({
    anchor: "newest",
    num_before: String(limit),
    num_after: "0",
    narrow: JSON.stringify(narrow),
  });
  const payload = await client.request<ZulipApiResponse & { messages?: ZulipMessage[] }>(
    `/messages?${qs.toString()}`,
  );
  assertSuccess(payload, "Zulip search failed");
  return payload.messages ?? [];
}

export async function fetchZulipUserPresence(
  client: ZulipClient,
  userIdOrEmail: string,
): Promise<ZulipPresenceMap> {
  const trimmed = userIdOrEmail?.trim();
  if (!trimmed) {
    throw new Error("userId or email is required to fetch Zulip presence.");
  }
  const encoded = encodeURIComponent(trimmed);
  const payload = await client.request<ZulipApiResponse & { presence?: ZulipPresenceMap }>(
    `/users/${encoded}/presence`,
  );
  assertSuccess(payload, "Zulip user presence failed");
  return payload.presence ?? {};
}

export async function deactivateZulipUser(client: ZulipClient, userId: string): Promise<void> {
  const trimmed = userId?.trim();
  if (!trimmed) {
    throw new Error("userId is required to deactivate a Zulip user.");
  }
  const payload = await client.request<ZulipApiResponse>(`/users/${trimmed}` as const, {
    method: "DELETE",
  });
  assertSuccess(payload, "Zulip deactivate user failed");
}

export async function reactivateZulipUser(client: ZulipClient, userId: string): Promise<void> {
  const trimmed = userId?.trim();
  if (!trimmed) {
    throw new Error("userId is required to reactivate a Zulip user.");
  }
  const payload = await client.request<ZulipApiResponse>(`/users/${trimmed}/reactivate` as const, {
    method: "POST",
  });
  assertSuccess(payload, "Zulip reactivate user failed");
}

export async function fetchZulipServerSettings(client: ZulipClient): Promise<ZulipServerSettings> {
  const payload = await client.request<ZulipServerSettings>("/server_settings");
  assertSuccess(payload, "Zulip server settings failed");
  return payload;
}

export async function updateZulipRealm(
  client: ZulipClient,
  params: ZulipRealmUpdate,
): Promise<void> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    body.set(key, String(value));
  }
  if (Array.from(body.keys()).length === 0) {
    throw new Error("No realm settings provided to update.");
  }
  const payload = await client.request<ZulipApiResponse>("/realm", {
    method: "PATCH",
    body: body.toString(),
  });
  assertSuccess(payload, "Zulip realm update failed");
}
