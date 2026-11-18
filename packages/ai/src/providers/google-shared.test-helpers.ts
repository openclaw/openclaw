// Google provider test helpers assert converted message and stream payloads.
import type { Model } from "../types.js";
import { buildGoogleGenerateContentParams } from "./google-shared.js";
import { makeProviderModel } from "./provider-model.test-support.js";

export function convertMessages(
  model: Parameters<typeof buildGoogleGenerateContentParams>[0],
  context: Parameters<typeof buildGoogleGenerateContentParams>[1],
) {
  return buildGoogleGenerateContentParams(model, context).contents;
}

function makeZeroUsageSnapshot() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

const assertRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected record");
  }
  return value as Record<string, unknown>;
};

type ConvertedTools = ReadonlyArray<{
  functionDeclarations?: ReadonlyArray<{
    parametersJsonSchema?: unknown;
    parameters?: unknown;
  }>;
}>;

export const getFirstToolParameters = (converted: ConvertedTools): Record<string, unknown> => {
  const functionDeclaration = assertRecord(converted?.[0]?.functionDeclarations?.[0]);
  return assertRecord(functionDeclaration.parametersJsonSchema ?? functionDeclaration.parameters);
};

export const makeModel = (id: string): Model<"google-generative-ai"> =>
  makeProviderModel("google-generative-ai", "google", id, {
    reasoning: false,
    contextWindow: 1,
    maxTokens: 1,
  });

export const makeGeminiCliModel = (id: string): Model<"google-gemini-cli"> =>
  makeProviderModel("google-gemini-cli", "google-gemini-cli", id, {
    reasoning: false,
    contextWindow: 1,
    maxTokens: 1,
  });

export function makeGoogleAssistantMessage(model: string, content: unknown) {
  return {
    role: "assistant",
    content,
    api: "google-generative-ai",
    provider: "google",
    model,
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop",
    timestamp: 0,
  };
}
