import { normalizeZulipBaseUrl } from "./normalize.js";

export type ZulipProbeResult = {
  ok: boolean;
  baseUrl?: string;
  bot?: {
    userId: number;
    email: string | null;
    fullName: string | null;
  };
  error?: string;
};

/**
 * Validate Zulip credentials by calling `/api/v1/users/me`.
 * Returns bot identity on success, or a diagnostic error message.
 */
export async function probeZulip(
  baseUrl: string,
  email: string,
  apiKey: string,
  timeoutMs?: number,
): Promise<ZulipProbeResult> {
  const normalized = normalizeZulipBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, error: "invalid baseUrl" };
  }
  const controller = new AbortController();
  const timeout = timeoutMs ? setTimeout(() => controller.abort(), Math.max(timeoutMs, 500)) : null;

  try {
    const authHeader = Buffer.from(`${email}:${apiKey}`, "utf8").toString("base64");
    const res = await fetch(`${normalized}/api/v1/users/me`, {
      headers: { Authorization: `Basic ${authHeader}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = res.statusText;
      try {
        const json = JSON.parse(text) as { msg?: string };
        if (json.msg) {
          detail = json.msg;
        }
      } catch {
        // ignore parse errors
      }
      return { ok: false, error: detail };
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
        userId: data.user_id ?? 0,
        email: data.email ?? null,
        fullName: data.full_name ?? null,
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
