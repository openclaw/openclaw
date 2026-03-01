import type { BaseProbeResult } from "openclaw/plugin-sdk";
import { normalizeMattermostBaseUrl, readMattermostError, type MattermostUser } from "./client.js";

export type MattermostProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: MattermostUser;
};

export async function probeMattermost(
  baseUrl: string,
  botToken: string,
  timeoutMs = 2500,
): Promise<MattermostProbe> {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, error: "baseUrl missing" };
  }
  const url = `${normalized}/api/v4/users/me`;
  const start = Date.now();
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  let timer: NodeJS.Timeout | null = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: controller?.signal,
    });
    const elapsedMs = Date.now() - start;
    if (!res.ok) {
      const detail = await readMattermostError(res);
      return {
        ok: false,
        status: res.status,
        error: detail || res.statusText,
        elapsedMs,
      };
    }
    const bot = (await res.json()) as MattermostUser;
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
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
