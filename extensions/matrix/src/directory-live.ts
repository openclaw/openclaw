import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk";
import { resolveMatrixAuth } from "./matrix/client.js";

type MatrixUserResult = {
  user_id?: string;
  display_name?: string;
};

type MatrixUserDirectoryResponse = {
  results?: MatrixUserResult[];
};

type MatrixJoinedRoomsResponse = {
  joined_rooms?: string[];
};

type MatrixRoomNameState = {
  name?: string;
};

type MatrixAliasLookup = {
  room_id?: string;
};

type MatrixDirectoryLiveParams = {
  cfg: unknown;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};

type MatrixResolvedAuth = Awaited<ReturnType<typeof resolveMatrixAuth>>;

async function fetchMatrixJson<T>(params: {
  homeserver: string;
  path: string;
  accessToken: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<T> {
  const res = await fetch(`${params.homeserver}${params.path}`, {
    method: params.method ?? "GET",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Matrix API ${params.path} failed (${res.status}): ${text || "unknown error"}`);
  }
  return (await res.json()) as T;
}

function normalizeQuery(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function resolveMatrixDirectoryLimit(limit?: number | null): number {
  return typeof limit === "number" && limit > 0 ? limit : 20;
}

async function resolveMatrixDirectoryContext(
  params: MatrixDirectoryLiveParams,
): Promise<{ query: string; auth: MatrixResolvedAuth } | null> {
  const query = normalizeQuery(params.query);
  if (!query) {
    return null;
  }
  const auth = await resolveMatrixAuth({ cfg: params.cfg as never, accountId: params.accountId });
  return { query, auth };
}

function createGroupDirectoryEntry(params: {
  id: string;
  name: string;
  handle?: string;
}): ChannelDirectoryEntry {
  return {
    kind: "group",
    id: params.id,
    name: params.name,
    handle: params.handle,
  } satisfies ChannelDirectoryEntry;
}

export async function listMatrixDirectoryPeersLive(
  params: MatrixDirectoryLiveParams,
): Promise<ChannelDirectoryEntry[]> {
  const context = await resolveMatrixDirectoryContext(params);
  if (!context) {
    return [];
  }
  const { query, auth } = context;
  const res = await fetchMatrixJson<MatrixUserDirectoryResponse>({
    homeserver: auth.homeserver,
    accessToken: auth.accessToken,
    path: "/_matrix/client/v3/user_directory/search",
    method: "POST",
    body: {
      search_term: query,
      limit: resolveMatrixDirectoryLimit(params.limit),
    },
  });
  const results = res.results ?? [];
  return results
    .map((entry) => {
      const userId = entry.user_id?.trim();
      if (!userId) {
        return null;
      }
      return {
        kind: "user",
        id: userId,
        name: entry.display_name?.trim() || undefined,
        handle: entry.display_name ? `@${entry.display_name.trim()}` : undefined,
        raw: entry,
      } satisfies ChannelDirectoryEntry;
    })
    .filter(Boolean) as ChannelDirectoryEntry[];
}

async function resolveMatrixRoomAlias(
  homeserver: string,
  accessToken: string,
  alias: string,
): Promise<string | null> {
  try {
    const res = await fetchMatrixJson<MatrixAliasLookup>({
      homeserver,
      accessToken,
      path: `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
    });
    return res.room_id?.trim() || null;
  } catch {
    return null;
  }
}

async function fetchMatrixRoomName(
  homeserver: string,
  accessToken: string,
  roomId: string,
): Promise<string | null> {
  try {
    const res = await fetchMatrixJson<MatrixRoomNameState>({
      homeserver,
      accessToken,
      path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
    });
    return res.name?.trim() || null;
  } catch {
    return null;
  }
}

export async function listMatrixDirectoryGroupsLive(
  params: MatrixDirectoryLiveParams,
): Promise<ChannelDirectoryEntry[]> {
  const context = await resolveMatrixDirectoryContext(params);
  if (!context) {
    return [];
  }
  const { query, auth } = context;
  const limit = resolveMatrixDirectoryLimit(params.limit);

  if (query.startsWith("#")) {
    const roomId = await resolveMatrixRoomAlias(auth.homeserver, auth.accessToken, query);
    if (!roomId) {
      return [];
    }
    return [createGroupDirectoryEntry({ id: roomId, name: query, handle: query })];
  }

  if (query.startsWith("!")) {
    return [createGroupDirectoryEntry({ id: query, name: query })];
  }

  const joined = await fetchMatrixJson<MatrixJoinedRoomsResponse>({
    homeserver: auth.homeserver,
    accessToken: auth.accessToken,
    path: "/_matrix/client/v3/joined_rooms",
  });
  const rooms = joined.joined_rooms ?? [];
  const results: ChannelDirectoryEntry[] = [];

  for (const roomId of rooms) {
    const name = await fetchMatrixRoomName(auth.homeserver, auth.accessToken, roomId);
    if (!name) {
      continue;
    }
    if (!name.toLowerCase().includes(query)) {
      continue;
    }
    results.push({
      kind: "group",
      id: roomId,
      name,
      handle: `#${name}`,
    });
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}
