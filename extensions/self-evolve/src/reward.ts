import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { SelfEvolveConfig } from "./types.js";

export type RewardInput = {
  userFeedback: string;
  intent: string;
  assistantResponse: string;
  toolSignals?: {
    toolCalls: number;
    toolFailures: number;
    toolSuccessRate: number;
    hasToolError: boolean;
  };
};

export type RewardResult = {
  score: number;
  confidence: number;
  source: "openai" | "unavailable";
  unavailableReason?: string;
};

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

const EXPLICIT_POSITIVE_PATTERNS = [
  /\b(thanks|thank you|great|good job|works|worked|fixed|resolved|perfect)\b/i,
  /(谢谢|很好|不错|可以了|解决了|搞定了|赞|牛)/,
];

const IMPLICIT_NEGATIVE_PATTERNS = [
  /\b(not working|doesn'?t work|still broken|try another way|another approach|problem)\b/i,
  /(有问题|换个方法|换一种|还是不行|不对|没解决|报错|失败)/,
];

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function looksLikeNewRequest(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  if (!cleaned) {
    return false;
  }
  if (cleaned.includes("?") || cleaned.includes("？")) {
    return true;
  }
  const starters = [
    "帮我",
    "请",
    "请你",
    "how ",
    "what ",
    "why ",
    "can you",
    "could you",
    "show me",
    "list ",
  ];
  return starters.some((prefix) => cleaned.startsWith(prefix));
}

export function calibrateRewardResult(result: RewardResult, input: RewardInput): RewardResult {
  if (result.source !== "openai") {
    return result;
  }
  const feedback = input.userFeedback.trim();
  if (!feedback) {
    return { ...result, score: 0, confidence: 0 };
  }

  const explicitPositive = hasPattern(feedback, EXPLICIT_POSITIVE_PATTERNS);
  const implicitNegative = hasPattern(feedback, IMPLICIT_NEGATIVE_PATTERNS);
  const newRequest = looksLikeNewRequest(feedback);
  const toolCalls = Math.max(0, input.toolSignals?.toolCalls ?? 0);
  const hasSignals = toolCalls > 0;
  const toolSuccessRate = hasSignals ? clamp01(input.toolSignals?.toolSuccessRate ?? 0) : 0;
  const hasToolError = hasSignals && Boolean(input.toolSignals?.hasToolError);

  let score = clampScore(result.score);
  let confidence = clamp01(result.confidence);

  if (newRequest && !explicitPositive && !implicitNegative) {
    score = clampScore(score * 0.2);
    confidence = Math.min(confidence, 0.45);
  }

  if (implicitNegative) {
    const penaltyFloor = hasSignals && (hasToolError || toolSuccessRate < 0.5) ? -0.7 : -0.45;
    score = Math.min(score, penaltyFloor);
    confidence = Math.max(confidence, 0.72);
  }

  if (explicitPositive) {
    if (hasSignals && !hasToolError && toolSuccessRate >= 0.9) {
      score = Math.max(score, 0.6);
      confidence = Math.max(confidence, 0.72);
    } else if (hasSignals && hasToolError) {
      confidence = Math.min(confidence, 0.6);
    }
  }

  if (!explicitPositive && hasSignals && hasToolError && score > 0.3) {
    score = clampScore(score * 0.65);
    confidence = Math.min(confidence, 0.65);
  }

  return {
    ...result,
    score: clampScore(score),
    confidence: clamp01(confidence),
  };
}

const RewardSchema = z.object({
  score: z.number(),
  confidence: z.number().nullable(),
  reason: z.string().nullable(),
});

function formatUnavailableReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return "openai-request-failed:unknown";
  }
  const base = error.name || "Error";
  const message = error.message?.trim() || "no-message";
  const asRecord = error as unknown as { status?: unknown; code?: unknown };
  const status = typeof asRecord.status === "number" ? ` status=${String(asRecord.status)}` : "";
  const code =
    typeof asRecord.code === "string" || typeof asRecord.code === "number"
      ? ` code=${String(asRecord.code)}`
      : "";
  return `openai-request-failed:${base}:${message}${status}${code}`;
}

export class RewardScorer {
  private readonly openaiClient: OpenAI | null;

  constructor(private readonly config: SelfEvolveConfig) {
    this.openaiClient =
      config.reward.provider === "openai" && config.reward.apiKey
        ? new OpenAI({ apiKey: config.reward.apiKey, baseURL: config.reward.baseUrl })
        : null;
  }

  async score(input: RewardInput): Promise<RewardResult> {
    if (!input.userFeedback.trim()) {
      return {
        score: 0,
        confidence: 0,
        source: "unavailable",
        unavailableReason: "empty-feedback",
      };
    }
    if (!this.openaiClient || this.config.reward.provider !== "openai") {
      return {
        score: 0,
        confidence: 0,
        source: "unavailable",
        unavailableReason: "openai-client-unavailable",
      };
    }
    try {
      const response = await this.openaiClient.responses.parse({
        model: this.config.reward.model,
        temperature: this.config.reward.temperature,
        input: [
          {
            role: "system",
            content: [
              "You are a strict reward model for agent learning.",
              "Evaluate whether the user's latest message reflects satisfaction or dissatisfaction with the previous assistant response.",
              "Important rules:",
              "1) If the user is asking a new question, switching topic, or giving neutral continuation with no explicit judgment, score MUST stay near zero in [-0.1, 0.1].",
              "2) Treat implicit dissatisfaction as negative feedback (e.g., 'still not working', 'try another way', '有问题', '换个方法').",
              "3) Consider tool execution outcomes as supporting evidence, but user feedback is primary.",
              "4) If evidence is weak or ambiguous, keep score near zero and lower confidence.",
              'Return JSON only: {"score": number, "confidence": number, "reason": string}.',
              "score in [-1,1], confidence in [0,1].",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `Previous intent:\n${input.intent}`,
              `Assistant response:\n${input.assistantResponse}`,
              `Tool outcome:\n${
                input.toolSignals
                  ? `calls=${input.toolSignals.toolCalls}, failures=${input.toolSignals.toolFailures}, successRate=${input.toolSignals.toolSuccessRate.toFixed(3)}, hasToolError=${String(input.toolSignals.hasToolError)}`
                  : "no-tool-signals"
              }`,
              `User follow-up feedback:\n${input.userFeedback}`,
            ].join("\n\n"),
          },
        ],
        text: {
          format: zodTextFormat(RewardSchema, "reward_feedback"),
        },
      });
      const parsed = response.output_parsed;
      if (!parsed) {
        return {
          score: 0,
          confidence: 0,
          source: "unavailable",
          unavailableReason: "empty-structured-output",
        };
      }
      const baseResult: RewardResult = {
        score: clampScore(parsed.score),
        confidence:
          typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
        source: "openai",
      };
      return calibrateRewardResult(baseResult, input);
    } catch (error) {
      return {
        score: 0,
        confidence: 0,
        source: "unavailable",
        unavailableReason: formatUnavailableReason(error),
      };
    }
  }
}
