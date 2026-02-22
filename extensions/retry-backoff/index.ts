/**
 * Retry Backoff Plugin
 *
 * Exponential retry with backoff for retryable model failures:
 * - rate_limit (429)
 * - timeout (408/502/503/504/ECONNRESET)
 * - unknown (no classifiable reason)
 *
 * When all fallback model candidates fail with a retryable reason,
 * retries the full candidate list after exponential backoff.
 * Handles single-provider scenarios where a 429 puts all profiles in cooldown.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

export {
  RETRYABLE_REASONS,
  computeRetryDelay,
  isRetryableRound,
  classifyError,
  extractRetryAfterMs,
  retryWithBackoff,
  sleep,
  type RetryConfig,
  type ClassifiedError,
  type RetryWithBackoffOptions,
} from "./src/retry-backoff.js";

const plugin = {
  id: "retry-backoff",
  name: "Retry Backoff",
  description:
    "Exponential retry backoff for retryable model failures (rate_limit, timeout, unknown, 429)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.on("health", () => {
      return {
        retryBackoff: {
          available: true,
          retryMaxRounds: 2,
        },
      };
    });
  },
};

export default plugin;
