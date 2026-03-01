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

export function buildRelayWsUrl(port, gatewayToken) {
  const token = String(gatewayToken || "").trim();
  if (!token) {
    throw new Error(
      "Missing gatewayToken in extension settings (chrome.storage.local.gatewayToken)",
    );
  }
  return `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(token)}`;
}

export function isRetryableReconnectError(err) {
  const message = err instanceof Error ? err.message : String(err || "");
  if (message.includes("Missing gatewayToken")) {
    return false;
  }
  return true;
}
