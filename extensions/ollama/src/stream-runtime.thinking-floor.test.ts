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

const local = { provider: "ollama", baseUrl: "http://127.0.0.1:11434" };
const hiddenReasoning = {
  ...local,
  id: "mandatory-thinking",
  params: { think: false },
  reasoning: false,
};

afterEach(() => {
  fetchMock.mockReset();
});

function createModel(overrides: Partial<ProviderRuntimeModel>): ProviderRuntimeModel {
  return {
    id: "glm-5.3",
    name: "test model",
    provider: "ollama-cloud",
    api: "ollama",
    baseUrl: "https://ollama.com",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
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

type Expected = string | boolean | undefined;
describe("Ollama models that cannot disable thinking", () => {
  it.each<[string, Partial<ProviderRuntimeModel>, "off" | "high", Expected]>([
    ["Off on glm-5.3", {}, "off", "low"],
    ["Off on glm-5.3-flash", { id: "glm-5.3-flash" }, "off", "low"],
    ["Off on a cloud ref through a local server", { ...local, id: "glm-5.3:cloud" }, "off", "low"],
    ["configured false on glm-5.3", { params: { think: false } }, "off", "low"],
    [
      "configured false kept by an unforwarded runtime level",
      { params: { think: false }, reasoning: false },
      "high",
      "low",
    ],
    [
      "discovered floor with hidden reasoning",
      { ...hiddenReasoning, thinkingLevelMap: { off: "true", high: "true" } },
      "high",
      true,
    ],
    ["High on glm-5.3", {}, "high", "high"],
    ["Off on glm-5.2, which lists false", { id: "glm-5.2" }, "off", false],
    ["Off on a local tag", { ...local, id: "glm-5.3:q4_K_M" }, "off", false],
  ])("agent turn: %s", async (_name, overrides, thinkingLevel, expected) => {
    const model = createModel(overrides);
    const streamFn = expectDefined(
      createConfiguredOllamaCompatStreamWrapper({
        provider: model.provider,
        modelId: model.id,
        model,
        thinkingLevel,
        streamFn: createConfiguredOllamaStreamFn({ model }),
      }),
      "wrapped stream",
    );
    expect(await readSentThink(model, streamFn)).toBe(expected);
  });

  // One-shot completions skip the agent wrapper; the transport must apply the floor too.
  it.each<[string, Partial<ProviderRuntimeModel>, Expected]>([
    ["configured false on glm-5.3", { params: { think: false } }, "low"],
    [
      "discovered floor with hidden reasoning",
      { ...hiddenReasoning, thinkingLevelMap: { off: "true" } },
      true,
    ],
    [
      "configured false on glm-5.2, which lists false",
      { id: "glm-5.2", params: { think: false } },
      false,
    ],
    ["no configured value on glm-5.3", {}, undefined],
  ])("direct completion: %s", async (_name, overrides, expected) => {
    const model = createModel(overrides);
    expect(await readSentThink(model, createConfiguredOllamaStreamFn({ model }))).toBe(expected);
  });
});
