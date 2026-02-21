/**
 * Agent Resilience Plugin
 *
 * Two recovery mechanisms for the embedded agent runner:
 *
 * 1. **Retryable-failure backoff** — When all fallback model candidates fail
 *    with a retryable reason (rate_limit, timeout, or unknown), retry the full
 *    candidate list after exponential backoff. This handles single-provider
 *    scenarios where a 429 puts all profiles in cooldown.
 *
 * 2. **Image auto-strip** — When the model returns an empty response and the
 *    context contains image blocks (e.g. vision-claimed provider actually
 *    can't handle images), strip all image blocks and retry. Also persists
 *    the strip to the session file to prevent reload of problematic images.
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

export {
  stripImageBlocksFromMessages,
  stripImageBlocksFromSessionFile,
  isEmptyAssistantContent,
  type ImageStripResult,
} from "./src/image-strip.js";

const plugin = {
  id: "agent-resilience",
  name: "Agent Resilience",
  description:
    "Timeout/unknown retry with backoff, and automatic image stripping on empty model response",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.on("health", () => {
      return {
        agentResilience: {
          available: true,
          retryMaxRounds: 2,
          imageStripEnabled: true,
        },
      };
    });
  },
};

export default plugin;
