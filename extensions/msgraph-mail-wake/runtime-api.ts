// Microsoft Graph Mail Wake runtime API module exposes runtime helpers.
export {
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  normalizeWebhookPath,
  readJsonWebhookBodyOrReject,
  resolveRequestClientIp,
  withResolvedWebhookRequestPipeline,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  type WebhookInFlightLimiter,
} from "openclaw/plugin-sdk/webhook-ingress";
export { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
export {
  isSecretRef,
  resolveConfiguredSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input-runtime";
export { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
export { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
export type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
