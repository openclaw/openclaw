import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { sanitizeMemoryText, stripConversationMetadata, truncateText } from "./prompt.js";
import type { SelfEvolveConfig } from "./types.js";

export type ToolTrace = {
  toolName: string;
  durationMs?: number;
  error?: string;
  params?: string;
  result?: string;
};

export type LlmTrace = {
  provider?: string;
  model?: string;
  usage?: string;
  assistantTexts: string[];
  reasoningSignals: string[];
};

export type ExperienceSummaryInput = {
  intent: string;
  assistantResponse: string;
  userFeedback: string;
  reward: number;
  rawTrace?: string;
  llmTrace?: LlmTrace;
  toolTrace: ToolTrace[];
};

export type ComposeExperienceInput = {
  summary: string;
  actionPath: string;
  outcome: "success" | "failure" | "neutral";
  assistantResponse: string;
  userFeedback: string;
  reward: number;
  toolOutcome: string;
  maxChars: number;
};

export function composeExperience(input: ComposeExperienceInput): string {
  const payload = [
    `summary: ${input.summary || "no_summary"}`,
    `action_path: ${input.actionPath || "no_action_captured"}`,
    `outcome: ${input.outcome}`,
    `assistant: ${input.assistantResponse || "none"}`,
    `user_feedback: ${input.userFeedback || "none"}`,
    `reward: ${input.reward.toFixed(3)}`,
    `tool_outcome: ${input.toolOutcome || "no_tool_calls"}`,
  ]
    .join("\n")
    .trim();
  return truncateText(sanitizeMemoryText(stripConversationMetadata(payload)), input.maxChars);
}

export function buildSummaryTracePayload(
  input: ExperienceSummaryInput,
  maxSummaryInputChars: number,
  maxRawChars: number,
): {
  intent: string;
  assistantResponse: string;
  userFeedback: string;
  reward: number;
  rawTrace: string;
  llmTrace?: LlmTrace;
  toolTrace: ToolTrace[];
} {
  return {
    intent: input.intent,
    assistantResponse: truncateText(input.assistantResponse, maxSummaryInputChars),
    userFeedback: truncateText(input.userFeedback, 420),
    reward: input.reward,
    rawTrace: truncateText(input.rawTrace ?? "", maxRawChars),
    llmTrace: input.llmTrace,
    toolTrace: input.toolTrace,
  };
}

function safeJson(value: unknown, maxChars: number): string {
  try {
    const text = JSON.stringify(value);
    return truncateText(text, maxChars);
  } catch {
    return "";
  }
}

function collectReasoningSignals(source: unknown): string[] {
  const signals: string[] = [];
  function walk(value: unknown, path: string): void {
    if (signals.length >= 8) {
      return;
    }
    if (typeof value === "string") {
      const key = path.toLowerCase();
      if ((key.includes("reason") || key.includes("think")) && value.trim().length > 0) {
        signals.push(truncateText(value.trim(), 180));
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        walk(value[index], `${path}[${index}]`);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      walk(child, `${path}.${key}`);
    }
  }
  walk(source, "assistant");
  return signals;
}

function usageToText(usage: unknown): string {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return "";
  }
  const asUsage = usage as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    const value = asUsage[key];
    if (typeof value === "number") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(" ");
}

export function buildLlmTrace(event: unknown, maxChars: number): LlmTrace {
  const asEvent = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
  const assistantTexts = Array.isArray(asEvent.assistantTexts)
    ? asEvent.assistantTexts
        .filter((value): value is string => typeof value === "string")
        .map((text) => truncateText(text, Math.floor(maxChars / 3)))
    : [];
  return {
    provider: typeof asEvent.provider === "string" ? asEvent.provider : undefined,
    model: typeof asEvent.model === "string" ? asEvent.model : undefined,
    usage: usageToText(asEvent.usage),
    assistantTexts,
    reasoningSignals: collectReasoningSignals(asEvent.lastAssistant),
  };
}

export function buildToolTrace(event: unknown, maxChars: number): ToolTrace {
  const asEvent = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
  return {
    toolName: typeof asEvent.toolName === "string" ? asEvent.toolName : "unknown",
    durationMs: typeof asEvent.durationMs === "number" ? asEvent.durationMs : undefined,
    error: typeof asEvent.error === "string" ? truncateText(asEvent.error, 220) : undefined,
    params: safeJson(asEvent.params, Math.floor(maxChars / 2)),
    result: safeJson(asEvent.result, Math.floor(maxChars / 2)),
  };
}

const ExperienceSummarySchema = z.object({
  summary: z.string().min(1),
});

export class ExperienceSummarizer {
  private readonly openaiClient: OpenAI | null;

  constructor(private readonly config: SelfEvolveConfig) {
    this.openaiClient =
      config.experience.summarizer === "openai" && config.experience.apiKey
        ? new OpenAI({ apiKey: config.experience.apiKey, baseURL: config.experience.baseUrl })
        : null;
  }

  async summarize(input: ExperienceSummaryInput): Promise<string> {
    if (!this.openaiClient || this.config.experience.summarizer !== "openai") {
      return "";
    }
    const tracePayload = buildSummaryTracePayload(input, 700, this.config.experience.maxRawChars);
    try {
      const response = await this.openaiClient.responses.parse({
        model: this.config.experience.model,
        temperature: this.config.experience.temperature,
        input: [
          {
            role: "system",
            content: [
              "Summarize an agent trajectory into reusable procedural memory for future similar tasks.",
              "Style requirements:",
              "1) Be action-oriented: describe the key action sequence and decision points.",
              "2) Be abstract: keep transferable strategy, avoid copying transient identifiers, raw message metadata, IDs, or exact sender tags.",
              "3) Be causal: include what caused success/failure and what safeguards to apply next time.",
              "4) Do not repeat the intent verbatim. Focus on strategy and lessons.",
              "5) Do not output sensitive information. Never include private user data, emails, phone numbers, home addresses, account IDs, API keys, access tokens, passwords, cookies, secrets, full local file paths, or exact command arguments containing secrets.",
              "6) If sensitive data appears in the trace, replace it with generic placeholders like [REDACTED_USER], [REDACTED_SECRET], [REDACTED_PATH].",
              'Return strict JSON only: {"summary": string}.',
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify(tracePayload),
          },
        ],
        text: {
          format: zodTextFormat(ExperienceSummarySchema, "experience_summary"),
        },
      });
      const parsed = response.output_parsed;
      if (!parsed?.summary?.trim()) {
        return "";
      }
      return truncateText(parsed.summary.trim(), this.config.experience.maxSummaryChars);
    } catch {
      return "";
    }
  }

  formatRawTrace(input: ExperienceSummaryInput): string {
    return truncateText(
      JSON.stringify(
        {
          llm: input.llmTrace,
          tools: input.toolTrace,
        },
        null,
        2,
      ),
      this.config.experience.maxRawChars,
    );
  }
}
