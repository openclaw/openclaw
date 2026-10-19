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
const cloudBaseUrl = "https://ollama.com";

afterEach(() => {
  fetchMock.mockReset();
});

describe.each(["runtime", "configured"] as const)(
  "%s maximum thinking on Ollama routes",
  (source) => {
    it.each([
      { name: "hosted model URL", modelBaseUrl: cloudBaseUrl, expected: "max" },
      {
        name: "hosted URL with transport path",
        modelBaseUrl: `${cloudBaseUrl}/v1/`,
        expected: "max",
      },
      {
        name: "hosted provider overrides local model",
        modelBaseUrl: localBaseUrl,
        providerBaseUrl: cloudBaseUrl,
        expected: "max",
      },
      {
        name: "local provider overrides hosted model",
        modelBaseUrl: cloudBaseUrl,
        providerBaseUrl: localBaseUrl,
        expected: "high",
      },
      { name: "plain local model", modelBaseUrl: localBaseUrl, expected: "high" },
      {
        name: "cloud ref at hosted URL",
        modelBaseUrl: cloudBaseUrl,
        id: "glm-5.2:cloud",
        expected: "max",
      },
      {
        // Ollama 0.21.2 and earlier reject max, and a local relay may run one.
        name: "cloud ref through local relay",
        modelBaseUrl: localBaseUrl,
        id: "glm-5.2:cloud",
        expected: "high",
      },
      {
        name: "unverified hosted model",
        modelBaseUrl: cloudBaseUrl,
        id: "qwen3:32b",
        expected: "high",
      },
      {
        name: "lookalike origin",
        modelBaseUrl: "https://ollama.com.example.test",
        expected: "high",
      },
    ])("$name sends $expected", async ({ modelBaseUrl, providerBaseUrl, id, expected }) => {
      fetchMock.mockResolvedValue({
        response: new Response(
          JSON.stringify({
            model: id ?? "glm-5.2",
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
        id: id ?? "glm-5.2",
        name: "test model",
        provider: "ollama",
        api: "ollama",
        baseUrl: modelBaseUrl,
        reasoning: true,
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(source === "configured" ? { params: { thinking: "max" } } : {}),
      };
      const baseStream = createConfiguredOllamaStreamFn({ model, providerBaseUrl });
      const streamFn = expectDefined(
        createConfiguredOllamaCompatStreamWrapper({
          provider: model.provider,
          modelId: model.id,
          model,
          config: providerBaseUrl
            ? {
                models: {
                  providers: { ollama: { baseUrl: providerBaseUrl, api: "ollama", models: [] } },
                },
              }
            : undefined,
          thinkingLevel: source === "runtime" ? "max" : "off",
          streamFn: baseStream,
        }),
        "wrapped stream",
      );
      const stream = await streamFn(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
        {},
      );
      const completed = await stream.result();
      expect(completed.stopReason).toBe("stop");
      const request = fetchMock.mock.calls[0]?.[0];
      expect(request.url).toBe(
        `${providerBaseUrl ?? modelBaseUrl.replace(/\/v1\/?$/, "")}/api/chat`,
      );
      expect(JSON.parse(request.init.body).think).toBe(expected);
    });
  },
);
