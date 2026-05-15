import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { CheckContext, GuardrailsDecision, HttpConfig, Logger } from "../config.js";
import type { GuardrailsProviderAdapter, ResolvedHttpConfig } from "../provider-types.js";

export const DKNOWNAI_DEFAULT_URL = "https://open.dknownai.com/v1/guard";

type DKnownAIResponse = {
  request_id: string;
  status: string;
};

/**
 * Resolve session_id for the DKnownAI API.
 * Priority: sessionKey > channelId:userId > random UUID.
 */
function resolveSessionId(context: CheckContext): string {
  return (
    context.sessionKey ??
    (context.channelId && context.userId
      ? `${context.channelId}:${context.userId}`
      : crypto.randomUUID())
  );
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
      logger.warn(`guardrail-bridge: dknownai returned unknown status "${status}" — falling back`);
      return { action: fallbackOnError };
  }
}

export function createDKnownAIAdapter(
  logger: Logger,
  defaultApiUrl = DKNOWNAI_DEFAULT_URL,
): GuardrailsProviderAdapter {
  return {
    check: async (
      text: string,
      context: CheckContext,
      config: ResolvedHttpConfig,
      fallbackOnError: "pass" | "block",
      timeoutMs: number,
    ): Promise<GuardrailsDecision> => {
      if (!config.apiKey) {
        logger.warn("guardrail-bridge: dknownai provider requires apiKey — falling back");
        return { action: fallbackOnError };
      }

      const url = config.apiUrl || defaultApiUrl;
      if (!url) {
        logger.warn("guardrail-bridge: dknownai provider requires apiUrl — falling back");
        return { action: fallbackOnError };
      }
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
          auditContext: "guardrail-bridge:dknownai",
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
