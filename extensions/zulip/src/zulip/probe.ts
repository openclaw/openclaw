import { normalizeZulipBaseUrl, readZulipError, type ZulipUser } from "./client.js";

export type ZulipProbe = {
  ok: boolean;
  baseUrl?: string;
  bot?: ZulipUser;
  error?: string;
};

export async function probeZulip(
  baseUrl: string,
  email: string,
  apiKey: string,
  timeoutMs?: number,
): Promise<ZulipProbe> {
  const normalized = normalizeZulipBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, error: "invalid baseUrl" };
  }
  const controller = new AbortController();
  const timeout = timeoutMs ? setTimeout(() => controller.abort(), Math.max(timeoutMs, 500)) : null;

  try {
    const authHeader = Buffer.from(`${email}:${apiKey}`).toString("base64");
    const res = await fetch(`${normalized}/api/v1/users/me`, {
      headers: {
        Authorization: `Basic ${authHeader}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await readZulipError(res);
      return { ok: false, error: detail || res.statusText };
    }
    const data = (await res.json()) as {
      result?: string;
      msg?: string;
      user_id?: number;
      email?: string;
      full_name?: string;
    };
    if (data.result && data.result !== "success") {
      return { ok: false, error: data.msg || "Zulip API error" };
    }
    return {
      ok: true,
      baseUrl: normalized,
      bot: {
        id: String(data.user_id ?? ""),
        email: data.email ?? null,
        full_name: data.full_name ?? null,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
