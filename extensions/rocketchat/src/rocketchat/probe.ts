import { normalizeRocketchatBaseUrl, type RocketchatUser } from "./client.js";

export type RocketchatProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: RocketchatUser;
};

async function readRocketchatError(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as { error?: string; message?: string } | undefined;
    if (data?.error) {
      return data.error;
    }
    if (data?.message) {
      return data.message;
    }
    return JSON.stringify(data);
  }
  return await res.text();
}

export async function probeRocketchat(
  baseUrl: string,
  authToken: string,
  userId: string,
  timeoutMs = 2500,
): Promise<RocketchatProbe> {
  const normalized = normalizeRocketchatBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, error: "baseUrl missing" };
  }
  const url = `${normalized}/api/v1/me`;
  const start = Date.now();
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  let timer: NodeJS.Timeout | null = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const res = await fetch(url, {
      headers: {
        "X-Auth-Token": authToken,
        "X-User-Id": userId,
      },
      signal: controller?.signal,
    });
    const elapsedMs = Date.now() - start;
    if (!res.ok) {
      const detail = await readRocketchatError(res);
      return {
        ok: false,
        status: res.status,
        error: detail || res.statusText,
        elapsedMs,
      };
    }
    const bot = (await res.json()) as RocketchatUser;
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
