import { readFileSync } from "node:fs";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/nextcloud-talk";
import { normalizeResolvedSecretInputString } from "./secret-input.js";
const ROOM_CACHE_TTL_MS = 5 * 60 * 1e3;
const ROOM_CACHE_ERROR_TTL_MS = 30 * 1e3;
const roomCache = /* @__PURE__ */ new Map();
function resolveRoomCacheKey(params) {
  return `${params.accountId}:${params.roomToken}`;
}
function readApiPassword(params) {
  const inlinePassword = normalizeResolvedSecretInputString({
    value: params.apiPassword,
    path: "channels.nextcloud-talk.apiPassword"
  });
  if (inlinePassword) {
    return inlinePassword;
  }
  if (!params.apiPasswordFile) {
    return void 0;
  }
  try {
    const value = readFileSync(params.apiPasswordFile, "utf-8").trim();
    return value || void 0;
  } catch {
    return void 0;
  }
}
function coerceRoomType(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function resolveRoomKindFromType(type) {
  if (!type) {
    return void 0;
  }
  if (type === 1 || type === 5 || type === 6) {
    return "direct";
  }
  return "group";
}
async function resolveNextcloudTalkRoomKind(params) {
  const { account, roomToken, runtime } = params;
  const key = resolveRoomCacheKey({ accountId: account.accountId, roomToken });
  const cached = roomCache.get(key);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (cached.kind && age < ROOM_CACHE_TTL_MS) {
      return cached.kind;
    }
    if (cached.error && age < ROOM_CACHE_ERROR_TTL_MS) {
      return void 0;
    }
  }
  const apiUser = account.config.apiUser?.trim();
  const apiPassword = readApiPassword({
    apiPassword: account.config.apiPassword,
    apiPasswordFile: account.config.apiPasswordFile
  });
  if (!apiUser || !apiPassword) {
    return void 0;
  }
  const baseUrl = account.baseUrl?.trim();
  if (!baseUrl) {
    return void 0;
  }
  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v4/room/${roomToken}`;
  const auth = Buffer.from(`${apiUser}:${apiPassword}`, "utf-8").toString("base64");
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: {
        method: "GET",
        headers: {
          Authorization: `Basic ${auth}`,
          "OCS-APIRequest": "true",
          Accept: "application/json"
        }
      },
      auditContext: "nextcloud-talk.room-info"
    });
    try {
      if (!response.ok) {
        roomCache.set(key, {
          fetchedAt: Date.now(),
          error: `status:${response.status}`
        });
        runtime?.log?.(
          `nextcloud-talk: room lookup failed (${response.status}) token=${roomToken}`
        );
        return void 0;
      }
      const payload = await response.json();
      const type = coerceRoomType(payload.ocs?.data?.type);
      const kind = resolveRoomKindFromType(type);
      roomCache.set(key, { fetchedAt: Date.now(), kind });
      return kind;
    } finally {
      await release();
    }
  } catch (err) {
    roomCache.set(key, {
      fetchedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err)
    });
    runtime?.error?.(`nextcloud-talk: room lookup error: ${String(err)}`);
    return void 0;
  }
}
export {
  resolveNextcloudTalkRoomKind
};
