import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/channel-contract";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixAuth } from "./matrix/client.js";
import { MatrixAuthedHttpClient } from "./matrix/sdk/http-client.js";
import { isMatrixQualifiedUserId, normalizeMatrixMessagingTarget } from "./matrix/target-ids.js";
import type { CoreConfig } from "./types.js";

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

type MatrixDirectoryLiveParams = {
  cfg: unknown;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};

const MATRIX_DIRECTORY_TIMEOUT_MS = 10_000;

function resolveMatrixDirectoryLimit(limit?: number | null): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.floor(limit))
    : 20;
}

async function createMatrixDirectoryClient(
  params: MatrixDirectoryLiveParams,
): Promise<MatrixAuthedHttpClient> {
  const auth = await resolveMatrixAuth({
    cfg: params.cfg as CoreConfig,
    accountId: params.accountId,
  });
  return new MatrixAuthedHttpClient({
    homeserver: auth.homeserver,
    accessToken: auth.accessToken,
    ssrfPolicy: auth.ssrfPolicy,
    dispatcherPolicy: auth.dispatcherPolicy,
  });
}

async function requestMatrixJson<T>(
  client: MatrixAuthedHttpClient,
  params: {
    method: "GET" | "POST";
    endpoint: string;
    body?: unknown;
  },
): Promise<T> {
  const result = await client.requestJson({
    method: params.method,
    endpoint: params.endpoint,
    body: params.body,
    timeoutMs: MATRIX_DIRECTORY_TIMEOUT_MS,
  });
  if (!isRecord(result)) {
    throw new Error(`Matrix homeserver returned a non-object JSON response for ${params.endpoint}`);
  }
  return result as T;
}

export async function listMatrixDirectoryPeersLive(
  params: MatrixDirectoryLiveParams,
): Promise<ChannelDirectoryEntry[]> {
  const query = normalizeOptionalString(params.query) ?? "";
  if (!query) {
    return [];
  }
  const directUserId = normalizeMatrixMessagingTarget(query);
  if (directUserId && isMatrixQualifiedUserId(directUserId)) {
    return [{ kind: "user", id: directUserId }];
  }
  const client = await createMatrixDirectoryClient(params);

  const res = await requestMatrixJson<MatrixUserDirectoryResponse>(client, {
    method: "POST",
    endpoint: "/_matrix/client/v3/user_directory/search",
    body: {
      search_term: query,
      limit: resolveMatrixDirectoryLimit(params.limit),
    },
  });
  const results = res.results ?? [];
  return results
    .map((entry) => {
      const userId = normalizeOptionalString(entry.user_id);
      if (!userId) {
        return null;
      }
      const displayName = normalizeOptionalString(entry.display_name);
      return {
        kind: "user",
        id: userId,
        name: displayName,
        handle: displayName ? `@${displayName}` : undefined,
        raw: entry,
      } satisfies ChannelDirectoryEntry;
    })
    .filter(Boolean) as ChannelDirectoryEntry[];
}

async function readOptionalMatrixDirectoryString(
  client: MatrixAuthedHttpClient,
  endpoint: string,
  field: string,
): Promise<string | null> {
  try {
    const res = await requestMatrixJson<Record<string, unknown>>(client, {
      method: "GET",
      endpoint,
    });
    return normalizeOptionalString(res[field]) ?? null;
  } catch {
    return null;
  }
}

export async function listMatrixDirectoryGroupsLive(
  params: MatrixDirectoryLiveParams,
): Promise<ChannelDirectoryEntry[]> {
  const query = normalizeOptionalString(params.query) ?? "";
  if (!query) {
    return [];
  }
  const directTarget = normalizeMatrixMessagingTarget(query);

  if (directTarget?.startsWith("!")) {
    return [{ kind: "group", id: directTarget, name: directTarget, handle: undefined }];
  }

  const client = await createMatrixDirectoryClient(params);
  const queryLower = normalizeLowercaseStringOrEmpty(query);
  const limit = resolveMatrixDirectoryLimit(params.limit);

  if (directTarget?.startsWith("#")) {
    const roomId = await readOptionalMatrixDirectoryString(
      client,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(directTarget)}`,
      "room_id",
    );
    if (!roomId) {
      return [];
    }
    return [{ kind: "group", id: roomId, name: directTarget, handle: directTarget }];
  }

  const joined = await requestMatrixJson<MatrixJoinedRoomsResponse>(client, {
    method: "GET",
    endpoint: "/_matrix/client/v3/joined_rooms",
  });
  const rooms = (joined.joined_rooms ?? [])
    .map((roomId) => normalizeOptionalString(roomId))
    .filter((roomId): roomId is string => Boolean(roomId));
  const results: ChannelDirectoryEntry[] = [];

  for (const roomId of rooms) {
    const name = await readOptionalMatrixDirectoryString(
      client,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
      "name",
    );
    if (!name || !normalizeLowercaseStringOrEmpty(name).includes(queryLower)) {
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
