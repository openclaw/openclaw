import { parseJsonOrThrow, type ZulipClient } from "./client.js";

type ZulipProbeResult = { ok: boolean; error?: string };

export async function probeZulip(
  client: ZulipClient,
  timeoutMs = 10_000,
): Promise<ZulipProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    // Use an authenticated endpoint to validate baseUrl + credentials.
    const url = new URL("/api/v1/users/me", client.baseUrl);
    const headers = new Headers();
    const token = Buffer.from(`${client.email}:${client.apiKey}`).toString("base64");
    headers.set("Authorization", `Basic ${token}`);

    const cfId = process.env.ZULIP_CF_ACCESS_CLIENT_ID?.trim();
    const cfSecret = process.env.ZULIP_CF_ACCESS_CLIENT_SECRET?.trim();
    if (cfId && cfSecret) {
      headers.set("CF-Access-Client-Id", cfId);
      headers.set("CF-Access-Client-Secret", cfSecret);
    }

    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });

    await parseJsonOrThrow(res);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      return { ok: false, error: `timeout after ${timeoutMs}ms` };
    }
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}
