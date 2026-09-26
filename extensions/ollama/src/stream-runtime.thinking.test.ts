import { expectDefined } from "@openclaw/normalization-core";
// Ollama tests cover the thinking values the stream runtime sends on the wire.
import { afterEach, describe, expect, it } from "vitest";
import {
  collectStreamEvents,
  expectSuccessfulOllamaRequest,
  getGuardedFetchJsonBody,
  requireOptionalRecord,
  resetOllamaStreamMocks,
  withSuccessfulOllamaFetch,
} from "./stream-runtime.test-support.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  createOllamaStreamFn,
} from "./stream.runtime.js";

afterEach(resetOllamaStreamMocks);

describe("createConfiguredOllamaCompatStreamWrapper native thinking", () => {
  it.each<{
    name: string;
    id: string;
    contextWindow: number;
    provider?: string;
    reasoning?: boolean;
    thinkingLevel: string;
    params?: Record<string, unknown>;
    expectedThink: boolean | string | undefined;
  }>([
    {
      name: "forwards think=false on native Ollama chat requests when thinking is off",
      id: "qwen3:32b",
      contextWindow: 131072,
      thinkingLevel: "off",
      expectedThink: false,
    },
    {
      name: "does not overwrite configured native Ollama params.thinking with implicit off",
      id: "qwen3:32b",
      contextWindow: 131072,
      thinkingLevel: "off",
      params: { thinking: "medium" },
      expectedThink: "medium",
    },
    {
      name: "does not forward truthy configured native Ollama thinking for non-reasoning models",
      id: "llama3.2:latest",
      contextWindow: 8192,
      reasoning: false,
      thinkingLevel: "off",
      params: { thinking: "medium" },
      expectedThink: undefined,
    },
    {
      name: "does not forward runtime native Ollama thinking for non-reasoning models",
      id: "llama3.2:latest",
      contextWindow: 8192,
      reasoning: false,
      thinkingLevel: "low",
      expectedThink: undefined,
    },
    ...(["low", "medium", "high"] as const).map((thinkingLevel) => ({
      name: `preserves native Ollama ${thinkingLevel} thinking on the wire`,
      id: "gpt-oss:20b",
      contextWindow: 131072,
      thinkingLevel,
      expectedThink: thinkingLevel,
    })),
    {
      name: "keeps the compatible local Ollama max mapping",
      id: "gpt-oss:20b",
      contextWindow: 131072,
      thinkingLevel: "max",
      expectedThink: "high",
    },
    {
      name: "does not infer native max support from a local cloud model alias",
      id: "glm-5.2:cloud",
      contextWindow: 131072,
      thinkingLevel: "max",
      expectedThink: "high",
    },
    {
      name: "preserves native Ollama Cloud max thinking on the wire",
      id: "glm-5.2",
      provider: "ollama-cloud",
      contextWindow: 131072,
      thinkingLevel: "max",
      expectedThink: "max",
    },
    {
      name: "preserves native Ollama Cloud GLM-5.3 max thinking on the wire",
      id: "glm-5.3",
      provider: "ollama-cloud",
      contextWindow: 131072,
      thinkingLevel: "max",
      expectedThink: "max",
    },
    {
      name: "keeps the high fallback for Ollama Cloud GPT-OSS",
      id: "gpt-oss:120b",
      provider: "ollama-cloud",
      contextWindow: 131072,
      thinkingLevel: "max",
      expectedThink: "high",
    },
    {
      name: "keeps the high fallback for Cloud models without a verified max tier",
      id: "kimi-k2.5",
      provider: "ollama-cloud",
      contextWindow: 131072,
      thinkingLevel: "max",
      expectedThink: "high",
    },
  ])(
    "$name",
    async ({
      id,
      provider = "ollama",
      contextWindow,
      reasoning,
      thinkingLevel,
      params,
      expectedThink,
    }) => {
      await withSuccessfulOllamaFetch(async (fetchMock) => {
        const model = {
          api: "ollama",
          provider,
          id,
          input: ["text"],
          contextWindow,
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(params ? { params } : {}),
        };
        const wrapped = expectDefined(
          createConfiguredOllamaCompatStreamWrapper({
            provider,
            modelId: id,
            model,
            streamFn: createOllamaStreamFn("http://ollama-host:11434"),
            thinkingLevel,
          } as never),
          "wrapped Ollama stream function",
        );
        const stream = await Promise.resolve(
          wrapped(
            model as never,
            { messages: [{ role: "user", content: "hello" }] } as never,
            {} as never,
          ),
        );
        await collectStreamEvents(stream);

        const requestBody = getGuardedFetchJsonBody(fetchMock);
        expect(requestBody.think).toBe(expectedThink);
        expect(requireOptionalRecord(requestBody.options)?.think).toBeUndefined();
        if (reasoning !== false) {
          expect(requireOptionalRecord(requestBody.options)?.num_ctx).toBeUndefined();
        }
      });
    },
  );
});

describe("createOllamaStreamFn configured thinking", () => {
  it.each(["low", "medium", "high"] as const)(
    "preserves configured native Ollama params.thinking=%s",
    async (thinking) => {
      await expectSuccessfulOllamaRequest(
        { baseUrl: "http://ollama-host:11434", model: { params: { thinking } } },
        ({ body }) => {
          expect(body.think).toBe(thinking);
          expect(requireOptionalRecord(body.options)?.think).toBeUndefined();
        },
      );
    },
  );

  it("keeps configured local Ollama params.thinking=max compatible", async () => {
    await expectSuccessfulOllamaRequest(
      { baseUrl: "http://ollama-host:11434", model: { params: { thinking: "max" } } },
      ({ body }) => {
        expect(body.think).toBe("high");
      },
    );
  });

  it.each(["glm-5.2", "glm-5.3"])(
    "preserves configured Ollama Cloud %s params.thinking=max",
    async (id) => {
      await expectSuccessfulOllamaRequest(
        {
          baseUrl: "https://ollama.com",
          model: { provider: "ollama-cloud", id, params: { thinking: "max" } },
        },
        ({ body }) => {
          expect(body.think).toBe("max");
        },
      );
    },
  );

  it.each(["gpt-oss:120b", "kimi-k2.5", "custom-thinking-model"])(
    "keeps configured Ollama Cloud %s params.thinking=max compatible",
    async (id) => {
      await expectSuccessfulOllamaRequest(
        {
          baseUrl: "https://ollama.com",
          model: { provider: "ollama-cloud", id, params: { thinking: "max" } },
        },
        ({ body }) => {
          expect(body.think).toBe("high");
        },
      );
    },
  );
});
