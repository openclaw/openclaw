/**
 * 从纳米网关拉取实时事件列表（路径与参数以合同为准，见环境变量）。
 * 认证：user + secret 查询参数（与 football-match-analyst 的 Nami 一致）。
 */

function envTrim() {
  return (k) => process.env[k]?.trim() ?? "";
}

function namiBase() {
  return (envTrim()("NAMI_API_BASE") || "https://open.sportnanoapi.com").replace(/\/$/, "");
}

async function namiFetch(user, secret, path, extraParams = {}) {
  const u = new URL(`${namiBase()}${path.startsWith("/") ? path : `/${path}`}`);
  u.searchParams.set("user", user);
  u.searchParams.set("secret", secret);
  for (const [k, v] of Object.entries(extraParams)) {
    if (v != null && v !== "") u.searchParams.set(k, String(v));
  }
  const res = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  return { httpStatus: res.status, json };
}

function ensureNamiOk(json) {
  if (json == null || typeof json !== "object") throw new Error("Invalid JSON body");
  if (json.err != null && json.err !== "") throw new Error(String(json.err));
  if (json.error != null && json.error !== "") throw new Error(String(json.error));
}

function unwrapList(json) {
  ensureNamiOk(json);
  const code = json.code ?? json.errCode;
  if (code != null && code !== 0 && code !== 200 && code !== "0") {
    const msg = json.msg ?? json.message ?? json.errMsg ?? `code=${code}`;
    throw new Error(String(msg));
  }
  const list =
    json.results ??
    json.data?.results ??
    (Array.isArray(json.data) ? json.data : null) ??
    json.list ??
    json.rows ??
    json.events ??
    [];
  return Array.isArray(list) ? list : [];
}

function mergeLiveExtra() {
  const raw = envTrim()("NAMI_LIVE_EXTRA");
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return typeof o === "object" && o != null ? o : {};
  } catch {
    return {};
  }
}

/**
 * @param {{ matchId: string|number, user: string, secret: string }} p
 * @returns {Promise<unknown[]>}
 */
export async function fetchNamiLiveEventList(p) {
  const path = envTrim()("NAMI_PATH_LIVE_EVENTS") || "/api/v5/football/match/live";
  const idKey = envTrim()("NAMI_PARAM_LIVE_MATCH_ID") || "match_id";
  const extra = { ...mergeLiveExtra(), [idKey]: String(p.matchId) };
  const { json } = await namiFetch(p.user, p.secret, path, extra);
  return unwrapList(json);
}
