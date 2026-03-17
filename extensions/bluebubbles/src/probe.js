import { normalizeSecretInputString } from "./secret-input.js";
import { buildBlueBubblesApiUrl, blueBubblesFetchWithTimeout } from "./types.js";
const MAX_SERVER_INFO_CACHE_SIZE = 64;
const serverInfoCache = /* @__PURE__ */ new Map();
const CACHE_TTL_MS = 10 * 60 * 1e3;
function buildCacheKey(accountId) {
  return accountId?.trim() || "default";
}
async function fetchBlueBubblesServerInfo(params) {
  const baseUrl = normalizeSecretInputString(params.baseUrl);
  const password = normalizeSecretInputString(params.password);
  if (!baseUrl || !password) {
    return null;
  }
  const cacheKey = buildCacheKey(params.accountId);
  const cached = serverInfoCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.info;
  }
  const url = buildBlueBubblesApiUrl({ baseUrl, path: "/api/v1/server/info", password });
  try {
    const res = await blueBubblesFetchWithTimeout(url, { method: "GET" }, params.timeoutMs ?? 5e3);
    if (!res.ok) {
      return null;
    }
    const payload = await res.json().catch(() => null);
    const data = payload?.data;
    if (data) {
      serverInfoCache.set(cacheKey, { info: data, expires: Date.now() + CACHE_TTL_MS });
      if (serverInfoCache.size > MAX_SERVER_INFO_CACHE_SIZE) {
        const oldest = serverInfoCache.keys().next().value;
        if (oldest !== void 0) {
          serverInfoCache.delete(oldest);
        }
      }
    }
    return data ?? null;
  } catch {
    return null;
  }
}
function getCachedBlueBubblesServerInfo(accountId) {
  const cacheKey = buildCacheKey(accountId);
  const cached = serverInfoCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.info;
  }
  return null;
}
function getCachedBlueBubblesPrivateApiStatus(accountId) {
  const info = getCachedBlueBubblesServerInfo(accountId);
  if (!info || typeof info.private_api !== "boolean") {
    return null;
  }
  return info.private_api;
}
function isBlueBubblesPrivateApiStatusEnabled(status) {
  return status === true;
}
function isBlueBubblesPrivateApiEnabled(accountId) {
  return isBlueBubblesPrivateApiStatusEnabled(getCachedBlueBubblesPrivateApiStatus(accountId));
}
function parseMacOSMajorVersion(version) {
  if (!version) {
    return null;
  }
  const match = /^(\d+)/.exec(version.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}
function isMacOS26OrHigher(accountId) {
  const info = getCachedBlueBubblesServerInfo(accountId);
  if (!info?.os_version) {
    return false;
  }
  const major = parseMacOSMajorVersion(info.os_version);
  return major !== null && major >= 26;
}
function clearServerInfoCache() {
  serverInfoCache.clear();
}
async function probeBlueBubbles(params) {
  const baseUrl = normalizeSecretInputString(params.baseUrl);
  const password = normalizeSecretInputString(params.password);
  if (!baseUrl) {
    return { ok: false, error: "serverUrl not configured" };
  }
  if (!password) {
    return { ok: false, error: "password not configured" };
  }
  const url = buildBlueBubblesApiUrl({ baseUrl, path: "/api/v1/ping", password });
  try {
    const res = await blueBubblesFetchWithTimeout(url, { method: "GET" }, params.timeoutMs);
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
export {
  clearServerInfoCache,
  fetchBlueBubblesServerInfo,
  getCachedBlueBubblesPrivateApiStatus,
  getCachedBlueBubblesServerInfo,
  isBlueBubblesPrivateApiEnabled,
  isBlueBubblesPrivateApiStatusEnabled,
  isMacOS26OrHigher,
  parseMacOSMajorVersion,
  probeBlueBubbles
};
