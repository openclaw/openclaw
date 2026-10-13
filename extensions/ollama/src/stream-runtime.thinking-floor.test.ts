import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: fetchMock }));

import {
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
} from "./stream.runtime.js";

const localBaseUrl = "http://127.0.0.1:11434";

type FloorCase = {
  name: string;
  provider: string;
  id: string;
  baseUrl?: string;
  params?: Record<string, unknown>;
  reasoning?: boolean;
  thinkingLevelMap?: ProviderRuntimeModel["thinkingLevelMap"];
  expected: string | boolean | undefined;
};

afterEach(() => {
  fetchMock.mockReset();
});

function createModel({
  provider,
  id,
  baseUrl,
  params,
  reasoning,
  thinkingLevelMap,
}: FloorCase): ProviderRuntimeModel {
  return {
    id,
    name: "test model",
    provider,
    api: "ollama",
    baseUrl: baseUrl ?? "https://ollama.com",
    reasoning: reasoning ?? true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(params ? { params } : {}),
  };
}

async function readSentThink(model: ProviderRuntimeModel, streamFn: StreamFn): Promise<unknown> {
  fetchMock.mockResolvedValue({
    response: new Response(
      JSON.stringify({
        model: model.id,
        created_at: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: "ok" },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      }) + "\n",
    ),
    release: async () => undefined,
  });
  const stream = await streamFn(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    {},
  );
  expect((await stream.result()).stopReason).toBe("stop");
  return JSON.parse(fetchMock.mock.calls[0]?.[0].init.body).think;
}

describe("Ollama models that cannot disable thinking", () => {
  it.each<FloorCase & { level: "off" | "high" }>([
    {
      name: "Off on glm-5.3",
      provider: "ollama-cloud",
      id: "glm-5.3",
      level: "off",
      expected: "low",
    },
    {
      name: "Off on glm-5.3-flash",
      provider: "ollama-cloud",
      id: "glm-5.3-flash",
      level: "off",
      expected: "low",
    },
    {
      name: "Off on a cloud ref through a local server",
      provider: "ollama",
      id: "glm-5.3:cloud",
      baseUrl: localBaseUrl,
      level: "off",
      expected: "low",
    },
    {
      name: "configured false on glm-5.3",
      provider: "ollama-cloud",
      id: "glm-5.3",
      level: "off",
      params: { think: false },
      expected: "low",
    },
    {
      name: "configured false kept by an unforwarded runtime level",
      provider: "ollama-cloud",
      id: "glm-5.3",
      level: "high",
      params: { think: false },
      reasoning: false,
      expected: "low",
    },
    {
      name: "discovered floor with hidden reasoning",
      provider: "ollama",
      id: "mandatory-thinking",
      baseUrl: localBaseUrl,
      level: "high",
      params: { think: false },
      reasoning: false,
      thinkingLevelMap: { off: "true", high: "true" },
      expected: true,
    },
    {
      name: "High on glm-5.3",
      provider: "ollama-cloud",
      id: "glm-5.3",
      level: "high",
      expected: "high",
    },
    {
      name: "Off on glm-5.2, which lists false",
      provider: "ollama-cloud",
      id: "glm-5.2",
      level: "off",
      expected: false,
    },
    {
      name: "Off on a local tag",
      provider: "ollama",
      id: "glm-5.3:q4_K_M",
      baseUrl: localBaseUrl,
      level: "off",
      expected: false,
    },
  ])("agent turn: $name sends $expected", async ({ level, ...testCase }) => {
    const model = createModel(testCase);
    const streamFn = expectDefined(
      createConfiguredOllamaCompatStreamWrapper({
        provider: testCase.provider,
        modelId: testCase.id,
        model,
        thinkingLevel: level,
        streamFn: createConfiguredOllamaStreamFn({ model }),
      }),
      "wrapped stream",
    );
    expect(await readSentThink(model, streamFn)).toBe(testCase.expected);
  });

  // Plugin llm.complete() and other one-shot completions call the transport without
  // the agent stream wrapper, so the transport itself must apply the floor.
  it.each<FloorCase>([
    {
      name: "configured false on glm-5.3",
      provider: "ollama-cloud",
      id: "glm-5.3",
      params: { think: false },
      expected: "low",
    },
    {
      name: "discovered floor with hidden reasoning",
      provider: "ollama",
      id: "mandatory-thinking",
      baseUrl: localBaseUrl,
      params: { think: false },
      reasoning: false,
      thinkingLevelMap: { off: "true" },
      expected: true,
    },
    {
      name: "configured false on glm-5.2, which lists false",
      provider: "ollama-cloud",
      id: "glm-5.2",
      params: { think: false },
      expected: false,
    },
    {
      name: "no configured value on glm-5.3",
      provider: "ollama-cloud",
      id: "glm-5.3",
      expected: undefined,
    },
  ])("direct completion: $name sends $expected", async (testCase) => {
    const model = createModel(testCase);
    expect(await readSentThink(model, createConfiguredOllamaStreamFn({ model }))).toBe(
      testCase.expected,
    );
  });
});
