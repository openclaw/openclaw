import {
  asPositiveFiniteNumber,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import type { FeishuConfig } from "./types.js";

/** Default HTTP timeout for Feishu API requests (30 seconds). */
export const FEISHU_HTTP_TIMEOUT_MS = 30_000;
const FEISHU_HTTP_TIMEOUT_MAX_MS = 300_000;
const FEISHU_HTTP_TIMEOUT_ENV_VAR = "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS";

type FeishuClientTimeoutConfig = {
  httpTimeoutMs?: number;
  config?: Pick<FeishuConfig, "httpTimeoutMs">;
};

export function resolveConfiguredHttpTimeoutMs(creds: FeishuClientTimeoutConfig): number {
  const timeout =
    asPositiveFiniteNumber(creds.httpTimeoutMs) ??
    parseStrictPositiveInteger(process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR]) ??
    asPositiveFiniteNumber(creds.config?.httpTimeoutMs) ??
    FEISHU_HTTP_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(timeout), 1), FEISHU_HTTP_TIMEOUT_MAX_MS);
}
