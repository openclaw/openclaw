import type { Health } from "./connect.js";

const HEALTH_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 15_000;

/** GBrain's `/health`: 200 `{status:"ok",version,engine}`, or 503 status-only with a `user_message` and `fix`. */
export async function readGbrainHealth(baseUrl: string): Promise<Health> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  } catch {
    return { kind: "down" };
  }
  const body = (await response.json().catch(() => undefined)) as
    | { status?: unknown; version?: unknown; user_message?: unknown; fix?: { command?: unknown } }
    | undefined;
  if (response.ok && body?.status === "ok" && typeof body.version === "string") {
    return { kind: "ok", version: body.version };
  }
  if (response.status === 503 && body?.status === "unavailable") {
    const fix =
      typeof body.fix?.command === "string" ? ` Run on the GBrain host: ${body.fix.command}` : "";
    const message =
      typeof body.user_message === "string"
        ? body.user_message
        : "The GBrain server is running but cannot open its brain.";
    return { kind: "status-only", message: `${message}${fix}` };
  }
  return { kind: "not-gbrain" };
}

/** True when GBrain's `/mcp` accepts the bearer for an MCP initialize request. */
export async function gbrainAcceptsToken(mcpUrl: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(mcpUrl, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    });
    await response.body?.cancel();
    return response.ok;
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
  const login = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken }),
  });
  await login.body?.cancel();
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!login.ok || !cookie) {
    throw new Error(`GBrain owner login failed (HTTP ${login.status}).`);
  }
  const mint = await fetch(`${baseUrl}/admin/api/api-keys`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name, scopes: ["read", "write"] }),
  });
  const body = (await mint.json().catch(() => undefined)) as
    | { token?: unknown; message?: unknown }
    | undefined;
  if (!mint.ok || typeof body?.token !== "string") {
    const detail = typeof body?.message === "string" ? `: ${body.message}` : "";
    throw new Error(`GBrain refused to create an OpenClaw key (HTTP ${mint.status})${detail}`);
  }
  return body.token;
}
