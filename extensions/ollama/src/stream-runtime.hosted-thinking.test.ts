import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModel } from "../model.test-support.js";

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
      ["hosted model URL", cloudBaseUrl, "max"],
      ["hosted URL with transport path", `${cloudBaseUrl}/v1/`, "max"],
      ["hosted provider overrides local model", localBaseUrl, "max", cloudBaseUrl],
      ["local provider overrides hosted model", cloudBaseUrl, "high", localBaseUrl],
      ["plain local model", localBaseUrl, "high"],
      ["cloud ref at hosted URL", cloudBaseUrl, "max", undefined, "glm-5.2:cloud"],
      // A local relay may run Ollama <= 0.21.2, which rejects max.
      ["cloud ref through local relay", localBaseUrl, "high", undefined, "glm-5.2:cloud"],
      ["unverified hosted model", cloudBaseUrl, "high", undefined, "qwen3:32b"],
      ["lookalike origin", "https://ollama.com.example.test", "high"],
    ])(
      "%s (%s → %s)",
      async (_name, modelBaseUrl, expected, providerBaseUrl?: string, id = "glm-5.2") => {
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
          ...createModel(id, "test model", { reasoning: true, contextWindow: 131072 }),
          provider: "ollama",
          api: "ollama",
          baseUrl: modelBaseUrl,
          ...(source === "configured" ? { params: { thinking: "max" } } : {}),
        };
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
            streamFn: createConfiguredOllamaStreamFn({ model, providerBaseUrl }),
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
      },
    );
  },
);
