import type { CheckContext, GuardrailsDecision, HttpConfig, Logger } from "../config.js";
import type { GuardrailsProviderAdapter } from "../http-connector.js";

const SECRA_DEFAULT_URL = "https://secra-backend-production.up.railway.app/v1/scan";

// /v1/scan recommendation values per Secra SDK 1.2.0 (models.py:18):
//   ALLOW  → pass
//   REVIEW → pass (flagged but not blocked; SDK exposes is_blocked === false)
//   BLOCK  → block
// BLOCK responses are returned with HTTP 403 and a `detail` envelope; other 403s
// are plan/auth gate errors and must not be treated as a scan verdict.
type SecraScanResponse = {
  recommendation?: string;
  threat_score?: number;
  threat_type?: string;
  tokens_consumed?: number;
  tokens_remaining?: number;
};

type SecraScanEnvelope = SecraScanResponse & {
  detail?: SecraScanResponse;
};

function buildMetadata(payload: SecraScanResponse): Record<string, unknown> {
  return {
    recommendation: payload.recommendation,
    threat_score: payload.threat_score,
    threat_type: payload.threat_type,
    tokens_consumed: payload.tokens_consumed,
    tokens_remaining: payload.tokens_remaining,
  };
}

export function createSecraAdapter(logger: Logger): GuardrailsProviderAdapter {
  return {
    async check(
      text: string,
      _context: CheckContext,
      config: HttpConfig,
      fallbackOnError: "pass" | "block",
      timeoutMs: number,
    ): Promise<GuardrailsDecision> {
      if (!config.apiKey) {
        logger.warn("guardrails: secra provider requires apiKey — falling back");
        return { action: fallbackOnError };
      }

      const url = config.apiUrl || SECRA_DEFAULT_URL;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ prompt: text }),
          signal: controller.signal,
        });

        // BLOCK results are delivered as HTTP 403 with a `detail` envelope.
        // 2xx responses carry an ALLOW/REVIEW/BLOCK payload directly; any other
        // status (401 auth, 429 rate-limit, plan-gate 403 without a scan detail)
        // is not a verdict and must fall back.
        const is403 = response.status === 403;
        if (!response.ok && !is403) {
          return { action: fallbackOnError };
        }

        let body: SecraScanEnvelope | null = null;
        try {
          body = (await response.json()) as SecraScanEnvelope;
        } catch {
          return { action: fallbackOnError };
        }

        const payload: SecraScanResponse | null = is403
          ? body?.detail && typeof body.detail === "object"
            ? body.detail
            : null
          : body;

        if (!payload?.recommendation) {
          if (response.ok) {
            logger.warn(
              "guardrails: secra provider response missing recommendation — falling back",
            );
          }
          return { action: fallbackOnError };
        }

        return {
          action: payload.recommendation === "BLOCK" ? "block" : "pass",
          metadata: buildMetadata(payload),
        };
      } catch {
        return { action: fallbackOnError };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
