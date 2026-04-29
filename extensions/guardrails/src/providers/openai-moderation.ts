import type { CheckContext, GuardrailsDecision, HttpConfig } from "../config.js";
import type { GuardrailsProviderAdapter } from "../http-connector.js";

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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ input: text, model: config.model }),
          signal: controller.signal,
        });

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
        clearTimeout(timer);
      }
    },
  };
}
