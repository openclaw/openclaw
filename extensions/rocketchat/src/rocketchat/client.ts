export type RocketchatClient = {
  baseUrl: string;
  apiBaseUrl: string;
  authToken: string;
  userId: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

export type RocketchatUser = {
  _id: string;
  username?: string | null;
  name?: string | null;
};

export type RocketchatRoom = {
  _id: string;
  name?: string | null;
  fname?: string | null;
  t?: string | null;
  teamId?: string | null;
};

export type RocketchatMessage = {
  _id: string;
  rid?: string | null;
  msg?: string | null;
  ts?: { $date: number } | null;
  u?: { _id: string; username?: string | null; name?: string | null } | null;
  tmid?: string | null;
  attachments?: Array<{
    title?: string | null;
    title_link?: string | null;
    image_url?: string | null;
    audio_url?: string | null;
    video_url?: string | null;
    type?: string | null;
  }> | null;
  file?: {
    _id: string;
    name?: string | null;
    type?: string | null;
    size?: number | null;
  } | null;
  files?: Array<{
    _id: string;
    name?: string | null;
    type?: string | null;
    size?: number | null;
  }> | null;
};

export type RocketchatFileInfo = {
  _id: string;
  name?: string | null;
  type?: string | null;
  size?: number | null;
};

export function normalizeRocketchatBaseUrl(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function buildRocketchatApiUrl(baseUrl: string, path: string): string {
  const normalized = normalizeRocketchatBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Rocket.Chat baseUrl is required");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}/api/v1${suffix}`;
}

async function readRocketchatError(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as { error?: string; message?: string } | undefined;
    if (data?.error) {
      return data.error;
    }
    if (data?.message) {
      return data.message;
    }
    return JSON.stringify(data);
  }
  return await res.text();
}

export function createRocketchatClient(params: {
  baseUrl: string;
  authToken: string;
  userId: string;
  fetchImpl?: typeof fetch;
}): RocketchatClient {
  const baseUrl = normalizeRocketchatBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new Error("Rocket.Chat baseUrl is required");
  }
  const apiBaseUrl = `${baseUrl}/api/v1`;
  const authToken = params.authToken.trim();
  const userId = params.userId.trim();
  const fetchImpl = params.fetchImpl ?? fetch;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = buildRocketchatApiUrl(baseUrl, path);
    const headers = new Headers(init?.headers);
    headers.set("X-Auth-Token", authToken);
    headers.set("X-User-Id", userId);
    if (typeof init?.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readRocketchatError(res);
      throw new Error(
        `Rocket.Chat API ${res.status} ${res.statusText}: ${detail || "unknown error"}`,
      );
    }
    return (await res.json()) as T;
  };

  return { baseUrl, apiBaseUrl, authToken, userId, request };
}

export async function fetchRocketchatMe(client: RocketchatClient): Promise<RocketchatUser> {
  const data = await client.request<{ user?: RocketchatUser } | RocketchatUser>("/me");
  if ("user" in data && data.user) {
    return data.user;
  }
  return data as RocketchatUser;
}

export async function fetchRocketchatUser(
  client: RocketchatClient,
  userId: string,
): Promise<RocketchatUser> {
  const data = await client.request<{ user: RocketchatUser }>(
    `/users.info?userId=${encodeURIComponent(userId)}`,
  );
  return data.user;
}

export async function fetchRocketchatUserByUsername(
  client: RocketchatClient,
  username: string,
): Promise<RocketchatUser> {
  const data = await client.request<{ user: RocketchatUser }>(
    `/users.info?username=${encodeURIComponent(username)}`,
  );
  return data.user;
}

export async function fetchRocketchatRoom(
  client: RocketchatClient,
  roomId: string,
): Promise<RocketchatRoom> {
  const data = await client.request<{ room: RocketchatRoom }>(
    `/rooms.info?roomId=${encodeURIComponent(roomId)}`,
  );
  return data.room;
}

export async function sendRocketchatTyping(
  client: RocketchatClient,
  params: { roomId: string; username: string; typing: boolean },
): Promise<void> {
  // Rocket.Chat typing is typically sent via Realtime API (WebSocket).
  // Via REST there is no direct typing endpoint, so this is a no-op.
  void params;
  void client;
}

export async function createRocketchatDm(
  client: RocketchatClient,
  usernames: string[],
): Promise<RocketchatRoom> {
  const data = await client.request<{ room: RocketchatRoom }>("/dm.create", {
    method: "POST",
    body: JSON.stringify({ usernames: usernames.join(",") }),
  });
  return data.room;
}

export async function sendRocketchatMessage(
  client: RocketchatClient,
  params: {
    roomId: string;
    text: string;
    tmid?: string;
  },
): Promise<RocketchatMessage> {
  const payload: Record<string, unknown> = {
    roomId: params.roomId,
    text: params.text,
  };
  if (params.tmid) {
    payload.tmid = params.tmid;
  }
  const data = await client.request<{ message: RocketchatMessage }>("/chat.sendMessage", {
    method: "POST",
    body: JSON.stringify({ message: payload }),
  });
  return data.message;
}

export async function uploadRocketchatFile(
  client: RocketchatClient,
  params: {
    roomId: string;
    buffer: Buffer;
    fileName: string;
    contentType?: string;
    description?: string;
    tmid?: string;
  },
): Promise<RocketchatMessage> {
  const form = new FormData();
  const fileName = params.fileName?.trim() || "upload";
  const bytes = Uint8Array.from(params.buffer);
  const blob = params.contentType
    ? new Blob([bytes], { type: params.contentType })
    : new Blob([bytes]);
  form.append("file", blob, fileName);
  if (params.description) {
    form.append("description", params.description);
  }
  if (params.tmid) {
    form.append("tmid", params.tmid);
  }

  const url = `${client.apiBaseUrl}/rooms.upload/${encodeURIComponent(params.roomId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Auth-Token": client.authToken,
      "X-User-Id": client.userId,
    },
    body: form,
  });

  if (!res.ok) {
    const detail = await readRocketchatError(res);
    throw new Error(
      `Rocket.Chat API ${res.status} ${res.statusText}: ${detail || "unknown error"}`,
    );
  }

  const data = (await res.json()) as { message?: RocketchatMessage };
  if (!data.message?._id) {
    throw new Error("Rocket.Chat file upload failed");
  }
  return data.message;
}
