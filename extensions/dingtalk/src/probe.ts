/**
 * DingTalk health probe utilities.
 */

import type { ResolvedDingTalkAccount } from "./accounts.js";

export interface ProbeResult {
  ok: boolean;
  error?: string;
  status?: number;
  elapsedMs?: number;
}

/**
 * Probe DingTalk API to verify credentials and connectivity.
 */
export async function probeDingTalk(
  account: ResolvedDingTalkAccount,
  timeoutMs = 5000,
): Promise<ProbeResult> {
  const start = Date.now();

  if (!account.clientId?.trim() || !account.clientSecret?.trim()) {
    return { ok: false, error: "Credentials not configured" };
  }

  try {
    // Try to get an access token as a connectivity test
    const url = `${account.apiBase}/v1.0/oauth2/accessToken`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: account.clientId,
        appSecret: account.clientSecret,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const elapsedMs = Date.now() - start;

    if (resp.ok) {
      const data = (await resp.json()) as { accessToken?: string; expireIn?: number };
      if (data.accessToken) {
        return { ok: true, elapsedMs };
      }
    }

    const errorText = await resp.text().catch(() => "");
    return {
      ok: false,
      status: resp.status,
      error: errorText.slice(0, 200) || `HTTP ${resp.status}`,
      elapsedMs,
    };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    return {
      ok: false,
      error: (err as Error)?.message ?? "Unknown error",
      elapsedMs,
    };
  }
}
