export type MattermostClient = {
  baseUrl: string;
  apiBaseUrl: string;
  token: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

export type MattermostUser = {
  id: string;
  username?: string | null;
  nickname?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

export type MattermostChannel = {
  id: string;
  name?: string | null;
  display_name?: string | null;
  type?: string | null;
  team_id?: string | null;
};

export type MattermostPost = {
  id: string;
  user_id?: string | null;
  channel_id?: string | null;
  message?: string | null;
  file_ids?: string[] | null;
  type?: string | null;
  root_id?: string | null;
  create_at?: number | null;
  props?: Record<string, unknown> | null;
};

export type MattermostFileInfo = {
  id: string;
  name?: string | null;
  mime_type?: string | null;
  size?: number | null;
};

export function normalizeMattermostBaseUrl(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  return withoutTrailing.replace(/\/api\/v4$/i, "");
}

function buildMattermostApiUrl(baseUrl: string, path: string): string {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Mattermost baseUrl is required");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}/api/v4${suffix}`;
}

async function readMattermostError(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as { message?: string } | undefined;
    if (data?.message) {
      return data.message;
    }
    return JSON.stringify(data);
  }
  return await res.text();
}

export function createMattermostClient(params: {
  baseUrl: string;
  botToken: string;
  fetchImpl?: typeof fetch;
}): MattermostClient {
  const baseUrl = normalizeMattermostBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new Error("Mattermost baseUrl is required");
  }
  const apiBaseUrl = `${baseUrl}/api/v4`;
  const token = params.botToken.trim();
  const fetchImpl = params.fetchImpl ?? fetch;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = buildMattermostApiUrl(baseUrl, path);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (typeof init?.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readMattermostError(res);
      throw new Error(
        `Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`,
      );
    }
    return (await res.json()) as T;
  };

  return { baseUrl, apiBaseUrl, token, request };
}

export async function fetchMattermostMe(client: MattermostClient): Promise<MattermostUser> {
  return await client.request<MattermostUser>("/users/me");
}

export async function fetchMattermostUser(
  client: MattermostClient,
  userId: string,
): Promise<MattermostUser> {
  return await client.request<MattermostUser>(`/users/${userId}`);
}

export async function fetchMattermostUserByUsername(
  client: MattermostClient,
  username: string,
): Promise<MattermostUser> {
  return await client.request<MattermostUser>(`/users/username/${encodeURIComponent(username)}`);
}

export async function fetchMattermostChannel(
  client: MattermostClient,
  channelId: string,
): Promise<MattermostChannel> {
  return await client.request<MattermostChannel>(`/channels/${channelId}`);
}

export async function sendMattermostTyping(
  client: MattermostClient,
  params: { channelId: string; parentId?: string },
): Promise<void> {
  const payload: Record<string, string> = {
    channel_id: params.channelId,
  };
  const parentId = params.parentId?.trim();
  if (parentId) {
    payload.parent_id = parentId;
  }
  await client.request<Record<string, unknown>>("/users/me/typing", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createMattermostDirectChannel(
  client: MattermostClient,
  userIds: string[],
): Promise<MattermostChannel> {
  return await client.request<MattermostChannel>("/channels/direct", {
    method: "POST",
    body: JSON.stringify(userIds),
  });
}

export async function createMattermostPost(
  client: MattermostClient,
  params: {
    channelId: string;
    message: string;
    rootId?: string;
    fileIds?: string[];
  },
): Promise<MattermostPost> {
  const payload: Record<string, string> = {
    channel_id: params.channelId,
    message: params.message,
  };
  if (params.rootId) {
    payload.root_id = params.rootId;
  }
  if (params.fileIds?.length) {
    (payload as Record<string, unknown>).file_ids = params.fileIds;
  }
  return await client.request<MattermostPost>("/posts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export type MattermostPostList = {
  order: string[];
  posts: Record<string, MattermostPost>;
};

export async function fetchChannelPosts(
  client: MattermostClient,
  channelId: string,
  opts?: { limit?: number; before?: string; after?: string; since?: number },
): Promise<MattermostPostList> {
  const params = new URLSearchParams();
  if (opts?.limit != null) {
    params.set("per_page", String(opts.limit));
  }
  if (opts?.before) {
    params.set("before", opts.before);
  }
  if (opts?.after) {
    params.set("after", opts.after);
  }
  if (opts?.since != null) {
    params.set("since", String(opts.since));
  }
  const qs = params.toString();
  const path = `/channels/${channelId}/posts${qs ? `?${qs}` : ""}`;
  return await client.request<MattermostPostList>(path);
}

export async function searchPosts(
  client: MattermostClient,
  teamId: string,
  terms: string,
  opts?: { channelId?: string; authorId?: string },
): Promise<MattermostPostList> {
  let finalTerms = terms;
  if (opts?.channelId) {
    finalTerms = `in:${opts.channelId} ${finalTerms}`;
  }
  if (opts?.authorId) {
    finalTerms = `from:${opts.authorId} ${finalTerms}`;
  }
  return await client.request<MattermostPostList>(`/teams/${teamId}/posts/search`, {
    method: "POST",
    body: JSON.stringify({ terms: finalTerms, is_or_search: false }),
  });
}

export async function fetchTeamChannels(
  client: MattermostClient,
  teamId: string,
  opts?: { limit?: number },
): Promise<MattermostChannel[]> {
  const params = new URLSearchParams();
  if (opts?.limit != null) {
    params.set("per_page", String(opts.limit));
  }
  const qs = params.toString();
  const path = `/teams/${teamId}/channels${qs ? `?${qs}` : ""}`;
  return await client.request<MattermostChannel[]>(path);
}
export async function uploadMattermostFile(
  client: MattermostClient,
  params: {
    channelId: string;
    buffer: Buffer;
    fileName: string;
    contentType?: string;
  },
): Promise<MattermostFileInfo> {
  const form = new FormData();
  const fileName = params.fileName?.trim() || "upload";
  const bytes = Uint8Array.from(params.buffer);
  const blob = params.contentType
    ? new Blob([bytes], { type: params.contentType })
    : new Blob([bytes]);
  form.append("files", blob, fileName);
  form.append("channel_id", params.channelId);

  const res = await fetch(`${client.apiBaseUrl}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.token}`,
    },
    body: form,
  });

  if (!res.ok) {
    const detail = await readMattermostError(res);
    throw new Error(`Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
  }

  const data = (await res.json()) as { file_infos?: MattermostFileInfo[] };
  const info = data.file_infos?.[0];
  if (!info?.id) {
    throw new Error("Mattermost file upload failed");
  }
  return info;
}
