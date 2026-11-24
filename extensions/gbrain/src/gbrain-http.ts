import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Health } from "./connect.js";

const HEALTH_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One request to GBrain's own server, which is local or on the Compose network: only that
 * exact origin is allowed, no redirects, and no capture (bodies carry owner and API keys).
 */
async function requestGbrain<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init,
    timeoutMs,
    maxRedirects: 0,
    capture: false,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(url),
    auditContext: "gbrain",
  });
  try {
    return await read(response);
  } finally {
    await release();
  }
}

/** GBrain's `/health`: 200 `{status:"ok",version,engine}`, or 503 status-only with a `user_message` and `fix`. */
export async function readGbrainHealth(baseUrl: string): Promise<Health> {
  let response: { ok: boolean; status: number; body: unknown };
  try {
    response = await requestGbrain(`${baseUrl}/health`, {}, HEALTH_TIMEOUT_MS, async (res) => ({
      ok: res.ok,
      status: res.status,
      body: await res.json().catch(() => undefined),
    }));
  } catch {
    return { kind: "down" };
  }
  const body = asOptionalRecord(response.body);
  const fixCommand = asOptionalRecord(body?.fix)?.command;
  if (response.ok && body?.status === "ok" && typeof body.version === "string") {
    return { kind: "ok", version: body.version };
  }
  if (response.status === 503 && body?.status === "unavailable") {
    const fix = typeof fixCommand === "string" ? ` Run on the GBrain host: ${fixCommand}` : "";
    const message =
      typeof body?.user_message === "string"
        ? body.user_message
        : "The GBrain server is running but cannot open its brain.";
    return { kind: "status-only", message: `${message}${fix}` };
  }
  return { kind: "not-gbrain" };
}

/** True when GBrain's `/mcp` accepts the bearer for an MCP initialize request. */
export async function gbrainAcceptsToken(mcpUrl: string, token: string): Promise<boolean> {
  try {
    return await requestGbrain(
      mcpUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "openclaw-gbrain-check", version: "1" },
          },
        }),
      },
      REQUEST_TIMEOUT_MS,
      async (response) => {
        await response.body?.cancel();
        return response.ok;
      },
    );
  } catch {
    return false;
  }
}

/**
 * Mint a read/write bearer through the running server's owner API (the
 * dashboard's API keys). `gbrain auth create` cannot: on PGLite the live
 * serve holds the brain, so a second process is refused.
 */
export async function mintGbrainKey(
  baseUrl: string,
  adminToken: string,
  name: string,
): Promise<string> {
  const login = await requestGbrain(
    `${baseUrl}/admin/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: adminToken }),
    },
    REQUEST_TIMEOUT_MS,
    async (response) => {
      await response.body?.cancel();
      return { ok: response.ok, status: response.status, cookies: response.headers.getSetCookie() };
    },
  );
  const cookie = login.cookies.map((value) => value.split(";")[0]).join("; ");
  if (!login.ok || !cookie) {
    throw new Error(`GBrain owner login failed (HTTP ${login.status}).`);
  }
  const mint = await requestGbrain(
    `${baseUrl}/admin/api/api-keys`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name, scopes: ["read", "write"] }),
    },
    REQUEST_TIMEOUT_MS,
    async (response) => ({
      ok: response.ok,
      status: response.status,
      body: asOptionalRecord(await response.json().catch(() => undefined)),
    }),
  );
  const body = mint.body;
  if (!mint.ok || typeof body?.token !== "string") {
    const detail = typeof body?.message === "string" ? `: ${body.message}` : "";
    throw new Error(`GBrain refused to create an OpenClaw key (HTTP ${mint.status})${detail}`);
  }
  return body.token;
}
