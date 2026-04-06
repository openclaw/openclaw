import { expect } from "vitest";

export function buildForwardCompatTemplate(params: {
  id: string;
  name: string;
  provider: string;
  api: "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";
  baseUrl: string;
  reasoning?: boolean;
  input?: readonly ["text"] | readonly ["text", "image"];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
}) {
  return {
    id: params.id,
    name: params.name,
    provider: params.provider,
    api: params.api,
    baseUrl: params.baseUrl,
    reasoning: params.reasoning ?? true,
    input: params.input ?? (["text", "image"] as const),
    cost: params.cost ?? { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: params.contextWindow ?? 200000,
    maxTokens: params.maxTokens ?? 64000,
  };
}

export function expectResolvedForwardCompatFallbackResult(params: {
  result: {
    error?: string;
    model?: unknown;
  };
  expectedModel: Record<string, unknown>;
}) {
  expect(params.result.error).toBeUndefined();
  expect(params.result.model).toMatchObject(params.expectedModel);
}

export function expectResolvedForwardCompatFallbackWithRegistryResult(params: {
  result: unknown;
  expectedModel: Record<string, unknown>;
}) {
  expect(params.result).toMatchObject(params.expectedModel);
}

export function expectUnknownModelErrorResult(
  result: {
    error?: string;
    model?: unknown;
  },
  provider: string,
  id: string,
) {
  expect(result.model).toBeUndefined();
  expect(result.error).toBe(`Unknown model: ${provider}/${id}`);
}
