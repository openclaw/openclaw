/**
 * Shared webhook notification delivery utilities.
 * Used by both pairing and handoff notification systems.
 */

export function parsePositiveInt(raw: string | undefined, fallback: number, min = 0): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

export function resolveEnvString(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) {
      const trimmed = String(value).trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

export async function postWebhookWithRetry(params: {
  endpoint: string;
  payload: unknown;
  authToken?: string;
  timeoutMs: number;
  retries: number;
}): Promise<boolean> {
  const { endpoint, payload, authToken, timeoutMs, retries } = params;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (response.ok) return true;
    } catch {
      // Best-effort delivery: keep notification in queue and retry later.
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}
