import { cloudStorageGet, cloudStorageSet } from "./telegram.js";

const TOKEN_KEY = "fs_token";

/** Try to restore a saved token from Telegram CloudStorage. */
export async function restoreToken(): Promise<string | null> {
  return await cloudStorageGet(TOKEN_KEY);
}

/** Save token to Telegram CloudStorage. */
export async function saveToken(token: string): Promise<void> {
  await cloudStorageSet(TOKEN_KEY, token);
}

/** Clear saved token from Telegram CloudStorage. */
export async function clearToken(): Promise<void> {
  await cloudStorageSet(TOKEN_KEY, "");
}

/**
 * Exchange a one-time pairing code for a session token.
 */
export async function exchangePairCode(pairCode: string): Promise<string> {
  const base = window.location.origin;
  const resp = await fetch(`${base}/plugins/telegram-files/api/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairCode }),
  });

  let data: unknown;
  const contentType = resp.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    data = await resp.json();
  } else {
    const text = await resp.text();
    data = { error: text || `HTTP ${resp.status}` };
  }

  if (!resp.ok || !data || typeof data !== "object" || !("token" in data)) {
    throw new Error((data as Record<string, string> | null)?.error ?? "Exchange failed");
  }
  return (data as { token: string }).token;
}
