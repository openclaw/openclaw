import type { BaseProbeResult } from "openclaw/plugin-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import { PUMBLE_API_BASE, readPumbleError, type PumbleUser } from "./client.js";

export type PumbleProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: PumbleUser;
};

export async function probePumble(
  botToken: string,
  timeoutMs = 2500,
  appKey?: string,
): Promise<PumbleProbe> {
  if (!botToken) {
    return { ok: false, error: "bot token missing" };
  }
  // Pumble uses /oauth2/me with custom "token" header (not Authorization: Bearer)
  const url = `${PUMBLE_API_BASE}/oauth2/me`;
  const start = Date.now();
  try {
    const headers: Record<string, string> = { token: botToken };
    if (appKey) {
      headers["x-app-token"] = appKey;
    }
    const { response: res, release } = await fetchWithSsrFGuard({
      url,
      init: { headers },
      timeoutMs,
    });
    const elapsedMs = Date.now() - start;
    if (!res.ok) {
      const detail = await readPumbleError(res);
      await release();
      return {
        ok: false,
        status: res.status,
        error: detail || res.statusText,
        elapsedMs,
      };
    }
    const raw = (await res.json()) as { workspaceUserId?: string; workspaceUserName?: string };
    await release();
    const bot: PumbleUser = {
      id: raw.workspaceUserId ?? "",
      name: raw.workspaceUserName,
      displayName: raw.workspaceUserName,
    };
    return {
      ok: true,
      status: res.status,
      elapsedMs,
      bot,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: null,
      error: message,
      elapsedMs: Date.now() - start,
    };
  }
}
