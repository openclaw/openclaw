import { expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveModel, resolveModelWithRegistry } from "./model.js";

const AGENT_DIR = "/tmp/agent";

export function buildForwardCompatTemplate(params: {
  id: string;
  name: string;
  provider: string;
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
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

export function expectResolvedForwardCompatFallback(params: {
  provider: string;
  id: string;
  expectedModel: Record<string, unknown>;
  cfg?: OpenClawConfig;
}) {
  const result = resolveModel(params.provider, params.id, AGENT_DIR, params.cfg);
  expect(result.error).toBeUndefined();
  expect(result.model).toMatchObject(params.expectedModel);
}

export function expectResolvedForwardCompatFallbackWithRegistry(params: {
  provider: string;
  id: string;
  expectedModel: Record<string, unknown>;
  cfg?: OpenClawConfig;
  registryEntries: readonly {
    provider: string;
    modelId: string;
    model: unknown;
  }[];
}) {
  const result = resolveModelWithRegistry({
    provider: params.provider,
    modelId: params.id,
    cfg: params.cfg,
    agentDir: AGENT_DIR,
    modelRegistry: {
      find(provider: string, modelId: string) {
        const match = params.registryEntries.find(
          (entry) => entry.provider === provider && entry.modelId === modelId,
        );
        return match?.model ?? null;
      },
    } as never,
  });
  expect(result).toMatchObject(params.expectedModel);
}

export function expectUnknownModelError(provider: string, id: string) {
  const result = resolveModel(provider, id, AGENT_DIR);
  expect(result.model).toBeUndefined();
  expect(result.error).toBe(`Unknown model: ${provider}/${id}`);
}
