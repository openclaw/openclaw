import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { SelfEvolveConfig } from "./types.js";

export type IntentDecision = {
  isMeaningful: boolean;
  confidence: number;
  source: "rule" | "openai" | "unavailable";
  reason: string;
};

const IntentSchema = z.object({
  isMeaningful: z.boolean(),
  confidence: z.number(),
  reason: z.string(),
});

const NON_INTENT_SHORT_PHRASES = new Set([
  "ok",
  "okay",
  "yes",
  "no",
  "yep",
  "nope",
  "thanks",
  "thank you",
  "got it",
  "sure",
  "是的",
  "不是",
  "好的",
  "好",
  "行",
  "嗯",
  "谢谢",
  "很好",
  "可以",
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isOnlySymbolsOrEmoji(text: string): boolean {
  if (text.trim().length === 0) {
    return true;
  }
  return !/[\p{L}\p{N}]/u.test(text);
}

function rulePrecheck(intent: string): IntentDecision | null {
  const trimmed = intent.trim();
  if (!trimmed) {
    return {
      isMeaningful: false,
      confidence: 1,
      source: "rule",
      reason: "empty-intent",
    };
  }
  if (isOnlySymbolsOrEmoji(trimmed)) {
    return {
      isMeaningful: false,
      confidence: 0.95,
      source: "rule",
      reason: "symbols-or-emoji-only",
    };
  }
  const normalized = normalize(trimmed);
  if (!normalized) {
    return {
      isMeaningful: false,
      confidence: 0.95,
      source: "rule",
      reason: "normalized-empty",
    };
  }
  if (normalized.length <= 8 && NON_INTENT_SHORT_PHRASES.has(normalized)) {
    return {
      isMeaningful: false,
      confidence: 0.9,
      source: "rule",
      reason: "short-acknowledgement",
    };
  }
  return null;
}

export class IntentJudge {
  private readonly openaiClient: OpenAI | null;

  constructor(private readonly config: SelfEvolveConfig) {
    this.openaiClient =
      config.reward.provider === "openai" && config.reward.apiKey
        ? new OpenAI({ apiKey: config.reward.apiKey, baseURL: config.reward.baseUrl })
        : null;
  }

  async judge(intent: string): Promise<IntentDecision> {
    const precheck = rulePrecheck(intent);
    if (precheck) {
      return precheck;
    }
    if (!this.openaiClient) {
      return {
        isMeaningful: false,
        confidence: 0,
        source: "unavailable",
        reason: "openai-client-unavailable",
      };
    }
    try {
      const response = await this.openaiClient.responses.parse({
        model: this.config.reward.model,
        temperature: 0,
        input: [
          {
            role: "system",
            content: [
              "Decide whether a user message is a meaningful task intent suitable for long-term episodic memory.",
              "Meaningful intent = concrete request/problem/question with reusable action pattern.",
              "Not meaningful = acknowledgement, greeting, filler, short sentiment only, or contextless continuation.",
              "Return strict JSON only.",
            ].join("\n"),
          },
          {
            role: "user",
            content: `Message:\n${intent}`,
          },
        ],
        text: {
          format: zodTextFormat(IntentSchema, "intent_decision"),
        },
      });
      const parsed = response.output_parsed;
      if (!parsed) {
        return {
          isMeaningful: false,
          confidence: 0,
          source: "unavailable",
          reason: "empty-structured-output",
        };
      }
      return {
        isMeaningful: parsed.isMeaningful,
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        source: "openai",
        reason: parsed.reason.trim() || "openai-no-reason",
      };
    } catch (error) {
      return {
        isMeaningful: false,
        confidence: 0,
        source: "unavailable",
        reason: `openai-request-failed:${error instanceof Error ? error.name : "unknown"}`,
      };
    }
  }
}
