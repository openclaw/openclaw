import {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS as WEBHOOK_ANOMALY_COUNTER_DEFAULTS_FROM_SDK,
  WEBHOOK_RATE_LIMIT_DEFAULTS as WEBHOOK_RATE_LIMIT_DEFAULTS_FROM_SDK
} from "openclaw/plugin-sdk/feishu";
const wsClients = /* @__PURE__ */ new Map();
const httpServers = /* @__PURE__ */ new Map();
const botOpenIds = /* @__PURE__ */ new Map();
const botNames = /* @__PURE__ */ new Map();
const FEISHU_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const FEISHU_WEBHOOK_BODY_TIMEOUT_MS = 3e4;
const FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS = {
  windowMs: 6e4,
  maxRequests: 120,
  maxTrackedKeys: 4096
};
const FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS = {
  maxTrackedKeys: 4096,
  ttlMs: 6 * 60 * 6e4,
  logEvery: 25
};
function coercePositiveInt(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}
function resolveFeishuWebhookRateLimitDefaultsForTest(defaults) {
  const resolved = defaults;
  return {
    windowMs: coercePositiveInt(
      resolved?.windowMs,
      FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.windowMs
    ),
    maxRequests: coercePositiveInt(
      resolved?.maxRequests,
      FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.maxRequests
    ),
    maxTrackedKeys: coercePositiveInt(
      resolved?.maxTrackedKeys,
      FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.maxTrackedKeys
    )
  };
}
function resolveFeishuWebhookAnomalyDefaultsForTest(defaults) {
  const resolved = defaults;
  return {
    maxTrackedKeys: coercePositiveInt(
      resolved?.maxTrackedKeys,
      FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.maxTrackedKeys
    ),
    ttlMs: coercePositiveInt(resolved?.ttlMs, FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.ttlMs),
    logEvery: coercePositiveInt(
      resolved?.logEvery,
      FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.logEvery
    )
  };
}
const feishuWebhookRateLimitDefaults = resolveFeishuWebhookRateLimitDefaultsForTest(
  WEBHOOK_RATE_LIMIT_DEFAULTS_FROM_SDK
);
const feishuWebhookAnomalyDefaults = resolveFeishuWebhookAnomalyDefaultsForTest(
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS_FROM_SDK
);
const feishuWebhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: feishuWebhookRateLimitDefaults.windowMs,
  maxRequests: feishuWebhookRateLimitDefaults.maxRequests,
  maxTrackedKeys: feishuWebhookRateLimitDefaults.maxTrackedKeys
});
const feishuWebhookAnomalyTracker = createWebhookAnomalyTracker({
  maxTrackedKeys: feishuWebhookAnomalyDefaults.maxTrackedKeys,
  ttlMs: feishuWebhookAnomalyDefaults.ttlMs,
  logEvery: feishuWebhookAnomalyDefaults.logEvery
});
function clearFeishuWebhookRateLimitStateForTest() {
  feishuWebhookRateLimiter.clear();
  feishuWebhookAnomalyTracker.clear();
}
function getFeishuWebhookRateLimitStateSizeForTest() {
  return feishuWebhookRateLimiter.size();
}
function isWebhookRateLimitedForTest(key, nowMs) {
  return feishuWebhookRateLimiter.isRateLimited(key, nowMs);
}
function recordWebhookStatus(runtime, accountId, path, statusCode) {
  feishuWebhookAnomalyTracker.record({
    key: `${accountId}:${path}:${statusCode}`,
    statusCode,
    log: runtime?.log ?? console.log,
    message: (count) => `feishu[${accountId}]: webhook anomaly path=${path} status=${statusCode} count=${count}`
  });
}
function stopFeishuMonitorState(accountId) {
  if (accountId) {
    wsClients.delete(accountId);
    const server = httpServers.get(accountId);
    if (server) {
      server.close();
      httpServers.delete(accountId);
    }
    botOpenIds.delete(accountId);
    botNames.delete(accountId);
    return;
  }
  wsClients.clear();
  for (const server of httpServers.values()) {
    server.close();
  }
  httpServers.clear();
  botOpenIds.clear();
  botNames.clear();
}
export {
  FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
  FEISHU_WEBHOOK_MAX_BODY_BYTES,
  botNames,
  botOpenIds,
  clearFeishuWebhookRateLimitStateForTest,
  feishuWebhookRateLimiter,
  getFeishuWebhookRateLimitStateSizeForTest,
  httpServers,
  isWebhookRateLimitedForTest,
  recordWebhookStatus,
  resolveFeishuWebhookAnomalyDefaultsForTest,
  resolveFeishuWebhookRateLimitDefaultsForTest,
  stopFeishuMonitorState,
  wsClients
};
