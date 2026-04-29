import { createHash } from "node:crypto";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { CheckContext, GuardrailsDecision, HttpConfig, Logger } from "../config.js";
import type { GuardrailsProviderAdapter } from "../provider-types.js";

const DKNOWNAI_DEFAULT_URL = "https://open.dknownai.com/v1/guard";

// UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DKnownAIResponse = {
  request_id: string;
  status: string;
};

/**
 * Convert an arbitrary string to a stable UUID v4-shaped hex string via SHA-256.
 * Ensures session_id is always in UUID format as required by the DKnownAI API.
 */
function toUUID(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  // Format as xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${(
    (Number.parseInt(hash[16], 16) & 0x3) |
    0x8
  ).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Resolve session_id for the DKnownAI API (must be UUID format).
 * Priority: sessionKey > channelId:userId > random UUID.
 * Non-UUID values are deterministically converted via SHA-256 hash.
 */
function resolveSessionId(context: CheckContext): string {
  const raw =
    context.sessionKey ??
    (context.channelId && context.userId ? `${context.channelId}:${context.userId}` : null);
  if (!raw) {
    return crypto.randomUUID();
  }
  return UUID_RE.test(raw) ? raw : toUUID(raw);
}

/**
 * DKnownAI status → GuardrailsDecision mapping.
 *
 * API returns one of four UPPER_SNAKE_CASE statuses (as of latest API):
 *   AGENT_HACK   → block  (prompt injection, jailbreak, system prompt extraction — our primary target)
 *   SYS_FLAG     → pass   (direct high-risk system ops without deceptive tactics; legitimate admin intent)
 *   CONTENT_FLAG → pass   (compliance/sensitive content; outside this plugin's scope)
 *   SAFE         → pass
 *   unknown      → fallbackOnError
 */
function mapStatusToDecision(
  status: string,
  requestId: string,
  fallbackOnError: "pass" | "block",
  logger: Logger,
): GuardrailsDecision {
  const meta = { request_id: requestId };

  switch (status) {
    case "AGENT_HACK":
      return { action: "block", metadata: meta };

    case "SYS_FLAG":
    case "CONTENT_FLAG":
    case "SAFE":
      return { action: "pass", metadata: meta };

    default:
      logger.warn(`guardrails: dknownai returned unknown status "${status}" — falling back`);
      return { action: fallbackOnError };
  }
}

export function createDKnownAIAdapter(logger: Logger): GuardrailsProviderAdapter {
  return {
    check: async (
      text: string,
      context: CheckContext,
      config: HttpConfig,
      fallbackOnError: "pass" | "block",
      timeoutMs: number,
    ): Promise<GuardrailsDecision> => {
      if (!config.apiKey) {
        logger.warn("guardrails: dknownai provider requires apiKey — falling back");
        return { action: fallbackOnError };
      }

      const url = config.apiUrl || DKNOWNAI_DEFAULT_URL;
      const requestId = crypto.randomUUID();
      const sessionId = resolveSessionId(context);

      let release: (() => Promise<void>) | undefined;
      try {
        const guarded = await fetchWithSsrFGuard({
          url,
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({ request_id: requestId, session_id: sessionId, input: text }),
          },
          timeoutMs,
          auditContext: "guardrails:dknownai",
        });
        release = guarded.release;
        const { response } = guarded;

        if (!response.ok) {
          return { action: fallbackOnError };
        }

        const data = (await response.json()) as DKnownAIResponse;
        return mapStatusToDecision(
          data.status,
          data.request_id ?? requestId,
          fallbackOnError,
          logger,
        );
      } catch {
        return { action: fallbackOnError };
      } finally {
        await release?.();
      }
    },
  };
}
