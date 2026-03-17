import {
  normalizeStringEntries
} from "openclaw/plugin-sdk/msteams";
import { formatUnknownError } from "./errors.js";
import { loadMSTeamsSdkWithAuth } from "./sdk.js";
import { readAccessToken } from "./token-response.js";
import { resolveMSTeamsCredentials } from "./token.js";
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  const payload = parts[1] ?? "";
  const padded = payload.padEnd(payload.length + (4 - payload.length % 4) % 4, "=");
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function readStringArray(value) {
  if (!Array.isArray(value)) {
    return void 0;
  }
  const out = normalizeStringEntries(value);
  return out.length > 0 ? out : void 0;
}
function readScopes(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const out = value.split(/\s+/).map((entry) => entry.trim()).filter(Boolean);
  return out.length > 0 ? out : void 0;
}
async function probeMSTeams(cfg) {
  const creds = resolveMSTeamsCredentials(cfg);
  if (!creds) {
    return {
      ok: false,
      error: "missing credentials (appId, appPassword, tenantId)"
    };
  }
  try {
    const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
    const tokenProvider = new sdk.MsalTokenProvider(authConfig);
    await tokenProvider.getAccessToken("https://api.botframework.com");
    let graph;
    try {
      const graphToken = await tokenProvider.getAccessToken("https://graph.microsoft.com");
      const accessToken = readAccessToken(graphToken);
      const payload = accessToken ? decodeJwtPayload(accessToken) : null;
      graph = {
        ok: true,
        roles: readStringArray(payload?.roles),
        scopes: readScopes(payload?.scp)
      };
    } catch (err) {
      graph = { ok: false, error: formatUnknownError(err) };
    }
    return { ok: true, appId: creds.appId, ...graph ? { graph } : {} };
  } catch (err) {
    return {
      ok: false,
      appId: creds.appId,
      error: formatUnknownError(err)
    };
  }
}
export {
  probeMSTeams
};
