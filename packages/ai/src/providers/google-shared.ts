import {
  type Content,
  FunctionCallingConfigMode,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type ThinkingConfig,
  ThinkingLevel,
} from "@google/genai";
import {
  isGoogleGemini3ProModel,
  isGoogleGemini3ThinkingLevelModel,
} from "../internal/google-model-family.js";
import { clampThinkingLevel } from "../model-utils.js";
import { transformProviderMessages as transformMessages } from "../provider-transcript-transform.js";
import { googleFlashSupportsMinimalThinking } from "../transports/google-thinking-level.js";
import {
  failTransportStream,
  notifyProviderStreamOpened,
  transportAbortError,
} from "../transports/transport-stream-shared.js";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingBudgets,
  ThinkingLevel as AgentThinkingLevel,
  StreamOptions,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  projectGoogleMessages,
  requiresGoogleToolCallId,
  convertGoogleTools,
} from "./google-messages.js";
import { consumeGoogleGenerateContentStream } from "./google-stream.js";
import { adjustMaxTokensForThinking } from "./simple-options.js";

export type GoogleApiType = "google-generative-ai" | "google-vertex" | "google-interactions";

type GoogleThinkingLevel = `${ThinkingLevel}`;

type GoogleToolChoice = "auto" | "none" | "any";

type GoogleThinkingOptions = {
  enabled: boolean;
  budgetTokens?: number;
  level?: GoogleThinkingLevel;
};

export type GoogleProviderOptions = StreamOptions & {
  toolChoice?: GoogleToolChoice;
  thinking?: GoogleThinkingOptions;
};

export type GoogleGenerateContentClient = {
  models: {
    generateContentStream(
      params: GenerateContentParameters,
    ): Promise<AsyncIterable<GenerateContentResponse>> | AsyncIterable<GenerateContentResponse>;
  };
};

type ClampedGoogleThinkingLevel = Exclude<AgentThinkingLevel, "xhigh" | "max">;

function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
  return projectGoogleMessages({
    model,
    messages: transformMessages(context.messages, model, (id) =>
      requiresGoogleToolCallId(model.id) ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : id,
    ),
    replay: "signed-parts",
    requiresToolCallSignature:
      model.provider !== "google-gemini-cli" && isGoogleGemini3ThinkingLevelModel(model.id),
  });
}

function mapToolChoice(choice: string): FunctionCallingConfigMode {
  return choice === "none"
    ? FunctionCallingConfigMode.NONE
    : choice === "any"
      ? FunctionCallingConfigMode.ANY
      : FunctionCallingConfigMode.AUTO;
}

export async function runGoogleGenerateContentLifecycle<T extends GoogleApiType>(params: {
  stream: AssistantMessageEventStream;
  model: Model<T>;
  output: AssistantMessage;
  options?: Pick<StreamOptions, "signal" | "onPayload">;
  createClient: () => GoogleGenerateContentClient;
  buildParams: () => GenerateContentParameters;
  nextToolCallId: (name: string | undefined) => string;
}): Promise<void> {
  const { stream, model, output, options } = params;

  try {
    const client = params.createClient();
    let requestParams = params.buildParams();
    const nextParams = await options?.onPayload?.(requestParams, model);
    if (nextParams !== undefined) {
      requestParams = nextParams as GenerateContentParameters;
    }
    const googleStream = await client.models.generateContentStream(requestParams);
    const googleIterator = googleStream[Symbol.asyncIterator]();
    await notifyProviderStreamOpened({
      options,
      cancelStream: async () => {
        await googleIterator.return?.();
      },
    });
    await consumeGoogleGenerateContentStream({
      chunks: { [Symbol.asyncIterator]: () => googleIterator },
      model,
      output,
      stream,
      signal: options?.signal,
      nextToolCallId: params.nextToolCallId,
    });
  } catch (error) {
    const failure = options?.signal?.aborted ? transportAbortError(options.signal) : error;
    failTransportStream({ stream, output, error: failure, signal: options?.signal });
  }
}

export function buildGoogleGenerateContentParams<T extends GoogleApiType>(
  model: Model<T>,
  context: Context,
  options: GoogleProviderOptions = {},
): Omit<GenerateContentParameters, "contents"> & { contents: Content[] } {
  const contents = convertMessages(model, context);

  const config: GenerateContentConfig = {
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...buildGoogleGenerationConfig(model, options.thinking, options.maxTokens),
    ...(options.stop !== undefined && options.stop.length > 0 && { stopSequences: options.stop }),
    ...(context.systemPrompt && {
      systemInstruction: sanitizeSurrogates(stripSystemPromptCacheBoundary(context.systemPrompt)),
    }),
    ...(context.tools && context.tools.length > 0 && { tools: convertGoogleTools(context.tools) }),
  };

  if (context.tools && context.tools.length > 0 && options.toolChoice) {
    config.toolConfig = {
      functionCallingConfig: {
        mode: mapToolChoice(options.toolChoice),
      },
    };
  } else {
    config.toolConfig = undefined;
  }

  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error("Request aborted");
    }
    config.abortSignal = options.signal;
  }

  return {
    model: model.id,
    contents,
    config,
  };
}

/** Shared wire policy for the Gemini API and Vertex, with or without the Google SDK. */
export function buildGoogleGenerationConfig(
  model: Pick<Model, "id" | "reasoning" | "maxTokens">,
  thinking: GoogleThinkingOptions | undefined,
  maxTokens: number | undefined,
): Pick<GenerateContentConfig, "maxOutputTokens" | "thinkingConfig"> {
  let thinkingConfig: ThinkingConfig | undefined;
  if (model.reasoning && thinking) {
    if (thinking.enabled) {
      thinkingConfig = { includeThoughts: true };
      if (thinking.level !== undefined) {
        const effort = {
          MINIMAL: "minimal",
          LOW: "low",
          MEDIUM: "medium",
          HIGH: "high",
          THINKING_LEVEL_UNSPECIFIED: undefined,
        } as const;
        const level = effort[thinking.level];
        thinkingConfig.thinkingLevel = level
          ? getGoogleThinkingLevel(level, model)
          : ThinkingLevel.THINKING_LEVEL_UNSPECIFIED;
      } else if (thinking.budgetTokens !== undefined) {
        if (isGoogleGemini3ThinkingLevelModel(model.id) && thinking.budgetTokens >= 0) {
          const budget = thinking.budgetTokens;
          thinkingConfig.thinkingLevel = getGoogleThinkingLevel(
            budget === 0 ? "minimal" : budget <= 2048 ? "low" : budget <= 8192 ? "medium" : "high",
            model,
          );
        } else {
          thinkingConfig.thinkingBudget = thinking.budgetTokens;
        }
      }
    } else {
      thinkingConfig = getDisabledGoogleThinkingConfig(model);
    }
    if (model.id.toLowerCase().includes("gemini-2.5-pro") && thinkingConfig.thinkingBudget === 0) {
      delete thinkingConfig.thinkingBudget;
    }
  }

  let maxOutputTokens = maxTokens;
  if (maxTokens !== undefined && model.reasoning) {
    // Pro cannot disable thinking. Bound its hidden work instead of letting a
    // dynamic budget consume a tiny visible-answer allowance.
    if (model.id.toLowerCase().includes("gemini-2.5-pro") && thinking?.enabled === false) {
      thinkingConfig = { thinkingBudget: 128 };
    } else if (
      model.id.toLowerCase().includes("gemini-2.5-pro") &&
      thinking?.budgetTokens === 0 &&
      thinkingConfig
    ) {
      thinkingConfig.thinkingBudget = 128;
    }
    const budget = thinkingConfig?.thinkingBudget;
    if (thinkingConfig && budget !== undefined && budget >= 0) {
      const adjusted = adjustMaxTokensForThinking(maxTokens, model.maxTokens, "low", {
        low: budget,
      });
      maxOutputTokens = adjusted.maxTokens;
      thinkingConfig.thinkingBudget = adjusted.thinkingBudget;
    }
  }
  return {
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    ...(thinkingConfig && Object.keys(thinkingConfig).length > 0 && { thinkingConfig }),
  };
}

function isAdaptiveGoogleReasoningLevel(value: unknown): value is "adaptive" {
  return value === "adaptive";
}

function buildGoogleThinking(
  model: Model,
  options: SimpleStreamOptions | undefined,
  interactions: boolean,
): GoogleThinkingOptions {
  const disabled = (): GoogleThinkingOptions => {
    const level =
      interactions && model.reasoning
        ? getDisabledGoogleThinkingConfig(model).thinkingLevel
        : undefined;
    return { enabled: false, ...(level ? { level } : {}) };
  };
  if (!options?.reasoning || options.reasoning === "off") {
    return disabled();
  }
  if (isAdaptiveGoogleReasoningLevel(options.reasoning)) {
    if (!model.reasoning) {
      return { enabled: false };
    }
    if (isGemma4Model(model)) {
      return { enabled: true, level: ThinkingLevel.HIGH };
    }
    return isGoogleGemini3ThinkingLevelModel(model.id)
      ? { enabled: true }
      : { enabled: true, budgetTokens: -1 };
  }

  const clampedReasoning = clampThinkingLevel(model, options.reasoning);
  if (clampedReasoning === "off") {
    return disabled();
  }
  const effort = (
    clampedReasoning === "max" ? "high" : clampedReasoning
  ) as ClampedGoogleThinkingLevel;

  if (interactions || isGoogleGemini3ThinkingLevelModel(model.id) || isGemma4Model(model)) {
    return {
      enabled: true,
      level: getGoogleThinkingLevel(effort, model),
    };
  }

  return {
    enabled: true,
    budgetTokens: getGoogleBudget(model, effort, options.thinkingBudgets),
  };
}

export function buildGoogleSimpleThinking(
  model: Model,
  options: SimpleStreamOptions | undefined,
): GoogleThinkingOptions {
  return buildGoogleThinking(model, options, false);
}

export function buildGoogleInteractionsSimpleThinking<T extends GoogleApiType>(
  model: Model<T>,
  options: SimpleStreamOptions | undefined,
): GoogleThinkingOptions {
  return buildGoogleThinking(model, options, true);
}

function getDisabledGoogleThinkingConfig(model: Pick<Model, "id">): ThinkingConfig {
  // Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
  // do not support full thinking-off either. For Gemini 3 and 4, use the lowest supported
  // thinkingLevel without includeThoughts so hidden thinking remains invisible to OpenClaw.
  if (isGoogleGemini3ProModel(model.id)) {
    return { thinkingLevel: ThinkingLevel.LOW };
  }
  if (isGoogleGemini3ThinkingLevelModel(model.id)) {
    return {
      thinkingLevel: googleFlashSupportsMinimalThinking(model.id)
        ? ThinkingLevel.MINIMAL
        : ThinkingLevel.LOW,
    };
  }
  if (isGemma4Model(model) || model.id.toLowerCase().includes("gemini-2.5-pro")) {
    return {};
  }

  // Gemini 2.x supports disabling via thinkingBudget = 0.
  return { thinkingBudget: 0 };
}

/** @internal Directly tested provider implementation detail. */
function isGemma4Model(model: Pick<Model, "id">): boolean {
  return /gemma-?4/.test(model.id.toLowerCase());
}

function getGoogleThinkingLevel(
  effort: ClampedGoogleThinkingLevel,
  model: Pick<Model, "id">,
): ThinkingLevel {
  const lowEffort = effort === "minimal" || effort === "low";
  if (isGoogleGemini3ProModel(model.id)) {
    return lowEffort ? ThinkingLevel.LOW : ThinkingLevel.HIGH;
  }
  if (isGemma4Model(model)) {
    return lowEffort ? ThinkingLevel.MINIMAL : ThinkingLevel.HIGH;
  }
  switch (effort) {
    case "minimal":
      return googleFlashSupportsMinimalThinking(model.id)
        ? ThinkingLevel.MINIMAL
        : ThinkingLevel.LOW;
    case "low":
      return ThinkingLevel.LOW;
    case "medium":
      return ThinkingLevel.MEDIUM;
    case "high":
      return ThinkingLevel.HIGH;
  }
  return ThinkingLevel.HIGH;
}

function getGoogleBudget(
  model: Model,
  effort: ClampedGoogleThinkingLevel,
  customBudgets?: ThinkingBudgets,
): number | undefined {
  if (customBudgets?.[effort] !== undefined) {
    return customBudgets[effort];
  }

  const isPro = model.id.includes("2.5-pro");
  if (isPro || model.id.includes("2.5-flash")) {
    const budgets: Record<ClampedGoogleThinkingLevel, number> = {
      minimal: !isPro && model.id.includes("2.5-flash-lite") ? 512 : 128,
      low: 2048,
      medium: 8192,
      high: isPro ? 32768 : 24576,
    };
    return budgets[effort];
  }

  return undefined;
}
