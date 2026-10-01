import { expectDefined } from "@openclaw/normalization-core";
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
  level: "off" | "high";
  baseUrl?: string;
  params?: Record<string, unknown>;
  reasoning?: boolean;
  expected: string | false;
};

afterEach(() => {
  fetchMock.mockReset();
});

describe("Ollama models that cannot disable thinking", () => {
  it.each<FloorCase>([
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
  ])(
    "$name sends $expected",
    async ({ provider, id, level, baseUrl, params, reasoning, expected }) => {
      fetchMock.mockResolvedValue({
        response: new Response(
          JSON.stringify({
            model: id,
            created_at: "2026-01-01T00:00:00Z",
            message: { role: "assistant", content: "ok" },
            done: true,
            prompt_eval_count: 1,
            eval_count: 1,
          }) + "\n",
        ),
        release: async () => undefined,
      });
      const model: ProviderRuntimeModel = {
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
        ...(params ? { params } : {}),
      };
      const streamFn = expectDefined(
        createConfiguredOllamaCompatStreamWrapper({
          provider,
          modelId: id,
          model,
          thinkingLevel: level,
          streamFn: createConfiguredOllamaStreamFn({ model }),
        }),
        "wrapped stream",
      );
      const stream = await streamFn(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
        {},
      );
      expect((await stream.result()).stopReason).toBe("stop");
      expect(JSON.parse(fetchMock.mock.calls[0]?.[0].init.body).think).toBe(expected);
    },
  );
});
