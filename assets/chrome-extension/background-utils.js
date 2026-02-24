export function reconnectDelayMs(
  attempt,
  opts = { baseMs: 1000, maxMs: 30000, jitterMs: 1000, random: Math.random },
) {
  const baseMs = Number.isFinite(opts.baseMs) ? opts.baseMs : 1000;
  const maxMs = Number.isFinite(opts.maxMs) ? opts.maxMs : 30000;
  const jitterMs = Number.isFinite(opts.jitterMs) ? opts.jitterMs : 1000;
  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const safeAttempt = Math.max(0, Number.isFinite(attempt) ? attempt : 0);
  const backoff = Math.min(baseMs * 2 ** safeAttempt, maxMs);
  return backoff + Math.max(0, jitterMs) * random();
}

export async function deriveRelayToken(port, gatewayToken) {
  const token = String(gatewayToken || "").trim();
  if (!token) return "";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const contextString = `openclaw-extension-relay-v1:${port}`;
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(contextString));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function buildRelayWsUrl(port, gatewayToken) {
  const derivedToken = await deriveRelayToken(port, gatewayToken);
  if (!derivedToken) {
    throw new Error(
      "Missing gatewayToken in extension settings (chrome.storage.local.gatewayToken)",
    );
  }
  return `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(derivedToken)}`;
}

export function isRetryableReconnectError(err) {
  const message = err instanceof Error ? err.message : String(err || "");
  if (message.includes("Missing gatewayToken")) {
    return false;
  }
  return true;
}
