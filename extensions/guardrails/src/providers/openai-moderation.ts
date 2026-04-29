import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { CheckContext, GuardrailsDecision, HttpConfig } from "../config.js";
import type { GuardrailsProviderAdapter } from "../provider-types.js";

const OPENAI_DEFAULT_URL = "https://api.openai.com/v1/moderations";

type OpenAIModerationResult = {
  results: Array<{
    flagged: boolean;
    categories: Record<string, boolean>;
    category_scores: Record<string, number>;
  }>;
};

export function createOpenAIModerationAdapter(logger?: {
  warn(msg: string): void;
}): GuardrailsProviderAdapter {
  return {
    async check(
      text: string,
      _context: CheckContext,
      config: HttpConfig,
      fallbackOnError: "pass" | "block",
      timeoutMs: number,
    ): Promise<GuardrailsDecision> {
      if (!config.apiKey) {
        logger?.warn("guardrails: openai-moderation provider requires apiKey — falling back");
        return { action: fallbackOnError };
      }

      const url = config.apiUrl || OPENAI_DEFAULT_URL;
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
            body: JSON.stringify({ input: text, model: config.model }),
          },
          timeoutMs,
          auditContext: "guardrails:openai-moderation",
        });
        release = guarded.release;
        const { response } = guarded;

        if (!response.ok) {
          return { action: fallbackOnError };
        }

        const data = (await response.json()) as OpenAIModerationResult;
        const result = data.results?.[0];
        if (!result) {
          return { action: fallbackOnError };
        }

        return {
          action: result.flagged ? "block" : "pass",
          raw: data,
        };
      } catch {
        return { action: fallbackOnError };
      } finally {
        await release?.();
      }
    },
  };
}
