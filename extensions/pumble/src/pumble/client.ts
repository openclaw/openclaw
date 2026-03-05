/**
 * Pumble API client — wraps the pumble-sdk REST API for direct HTTP calls.
 *
 * The pumble-sdk provides a higher-level `AddonService` with `getBotClient()`,
 * but for probing and simple sends we use a thin HTTP layer here so the extension
 * can work without starting the full SDK server.
 */

export const PUMBLE_API_BASE = "https://api-ga.pumble.com";

export type PumbleClient = {
  apiBase: string;
  botUserId?: string;
  /** Returns auth headers for direct HTTP requests (e.g. file downloads). */
  getAuthHeaders: () => Record<string, string>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

export type PumbleUser = {
  id: string;
  name?: string;
  displayName?: string;
  email?: string;
  isBot?: boolean;
};

export type PumbleChannel = {
  id: string;
  name?: string;
  /** Legacy field from older Pumble SDK versions; prefer `channelType`. */
  type?: string;
  /** Pumble API returns `channelType` (e.g. "PUBLIC_CHANNEL", "DIRECT_MESSAGE"). */
  channelType?: string;
};

export type PumbleMessage = {
  id: string;
  channelId?: string;
  text?: string;
  authorId?: string;
  threadRootId?: string;
  createdAt?: number;
};

export async function readPumbleError(res: Response): Promise<string> {
  try {
    const body = await res.text();
    const json = JSON.parse(body);
    return json.message ?? json.error ?? body;
  } catch {
    return res.statusText;
  }
}

export function createPumbleClient(params: {
  botToken: string;
  appKey?: string;
  apiBase?: string;
  botUserId?: string;
  fetchImpl?: typeof fetch;
}): PumbleClient {
  const apiBase = params.apiBase ?? PUMBLE_API_BASE;
  const fetchFn = params.fetchImpl ?? fetch;

  const getAuthHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { token: params.botToken };
    if (params.appKey) {
      headers["x-app-token"] = params.appKey;
    }
    return headers;
  };

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = `${apiBase}${path}`;
    const res = await fetchFn(url, {
      ...init,
      headers: {
        ...getAuthHeaders(),
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const detail = await readPumbleError(res);
      throw new Error(`Pumble API error ${res.status}: ${detail}`);
    }
    const text = await res.text();
    if (!text) {
      // Pumble endpoints like reactions return 200 with empty body.
      // Callers using void-returning wrappers (e.g. addPumbleReactionRest)
      // discard this value; typed callers always get a JSON body.
      return undefined as T;
    }
    return JSON.parse(text) as T;
  };

  return {
    apiBase,
    botUserId: params.botUserId,
    getAuthHeaders,
    request,
  };
}

export async function fetchPumbleMe(client: PumbleClient): Promise<PumbleUser> {
  // Pumble uses /oauth2/me for the authenticated user's profile
  const raw = await client.request<{ workspaceUserId: string; workspaceUserName?: string }>(
    "/oauth2/me",
  );
  return {
    id: raw.workspaceUserId,
    name: raw.workspaceUserName,
    displayName: raw.workspaceUserName,
  };
}

export async function fetchPumbleUser(client: PumbleClient, userId: string): Promise<PumbleUser> {
  return client.request<PumbleUser>(`/v1/workspaceUsers/${userId}`);
}

export async function fetchPumbleChannel(
  client: PumbleClient,
  channelId: string,
): Promise<PumbleChannel> {
  // Pumble GET /v1/channels/{id} wraps the channel inside
  // { channel: PumbleChannel, pinnedMessages, users }.
  const res = await client.request<{ channel: PumbleChannel } | PumbleChannel>(
    `/v1/channels/${channelId}`,
  );
  if ("channel" in res && res.channel) {
    return res.channel;
  }
  return res as PumbleChannel;
}

export async function postPumbleMessage(
  client: PumbleClient,
  params: { channelId: string; text: string; threadRootId?: string },
): Promise<PumbleMessage> {
  if (params.threadRootId) {
    // POST to /v1/channels/{channelId}/messages/{threadRootId} — same path as
    // the SDK's `reply()` method. The `/replies` suffix is GET-only (fetch).
    return client.request<PumbleMessage>(
      `/v1/channels/${params.channelId}/messages/${params.threadRootId}`,
      {
        method: "POST",
        body: JSON.stringify({ text: params.text }),
      },
    );
  }
  return client.request<PumbleMessage>(`/v1/channels/${params.channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: params.text }),
  });
}

export async function postPumbleDm(
  client: PumbleClient,
  params: { userId: string; text: string; botUserId?: string },
): Promise<PumbleMessage> {
  // Pumble DMs require resolving the direct channel first, then posting there.
  // The SDK does: GET /v1/channels/direct?participantIds=botId,userId → channel.id
  // then POST /v1/channels/{channelId}/messages.
  const botId = params.botUserId ?? client.botUserId;
  const participantIds = botId ? `${botId},${params.userId}` : params.userId;
  const dmChannel = await client.request<{ channel: { id: string } }>(
    `/v1/channels/direct?participantIds=${encodeURIComponent(participantIds)}`,
  );
  const channelId = dmChannel?.channel?.id;
  if (!channelId) {
    throw new Error(`Could not resolve DM channel for user ${params.userId}`);
  }
  return postPumbleMessage(client, { channelId, text: params.text });
}

export async function listPumbleWorkspaceUsers(client: PumbleClient): Promise<PumbleUser[]> {
  return client.request<PumbleUser[]>("/v1/workspaceUsers");
}

export async function listPumbleChannels(client: PumbleClient): Promise<PumbleChannel[]> {
  return client.request<PumbleChannel[]>("/v1/channels");
}

export async function addPumbleReactionRest(
  client: PumbleClient,
  params: { messageId: string; emojiCode: string },
): Promise<void> {
  await client.request(`/v1/messages/${params.messageId}/reactions`, {
    method: "POST",
    body: JSON.stringify({ code: params.emojiCode }),
  });
}

export async function removePumbleReactionRest(
  client: PumbleClient,
  params: { messageId: string; emojiCode: string },
): Promise<void> {
  await client.request(`/v1/messages/${params.messageId}/reactions`, {
    method: "DELETE",
    body: JSON.stringify({ code: params.emojiCode }),
  });
}
