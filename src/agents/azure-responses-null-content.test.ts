import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";

function createAzureResponsesModel(): Model<"azure-openai-responses"> {
  return {
    id: "gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    api: "azure-openai-responses",
    provider: "azure-openai-responses-devdiv",
    baseUrl: "https://example.openai.azure.com/openai/responses",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

function neverYieldsStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => await new Promise<IteratorResult<unknown>>(() => {}),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

describe("azure responses sanitize", () => {
  it("sanitizes null content in Azure Responses send boundary before SDK serialization", async () => {
    const captured: unknown[] = [];
    vi.resetModules();
    vi.doMock("openai", async (importOriginal) => {
      const original = await importOriginal<typeof import("openai")>();
      return {
        ...original,
        default: original.default,
        AzureOpenAI: vi.fn().mockImplementation(function () {
          const createMock = vi.fn(async (request: unknown) => {
            captured.push(request);
            return neverYieldsStream();
          });
          return { responses: { create: createMock } };
        }),
      };
    });

    try {
      const { createAzureOpenAIResponsesTransportStreamFn } =
        await import("./openai-transport-stream.js");
      const streamFn = createAzureOpenAIResponsesTransportStreamFn();
      const model = createAzureResponsesModel();

      streamFn(
        model,
        {
          messages: [
            { role: "system", content: "You are a helpful assistant" },
            { role: "user", content: "Hello" },
          ],
        },
        {
          apiKey: "test-key",
          onPayload: (params) => {
            const p = params as { input: Array<Record<string, unknown>> };
            p.input.push({ role: "assistant", content: null });
            p.input.push({ role: "user", content: null });
            p.input.push({ role: "developer", content: null });
            return p;
          },
        },
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      const { AzureOpenAI } = await import("openai");
      const mockAzureOpenAI = AzureOpenAI as unknown as ReturnType<typeof vi.fn>;

      expect(mockAzureOpenAI).toHaveBeenCalledTimes(1);
      expect(captured.length).toBe(1);

      const sent = captured[0] as { input: Array<Record<string, unknown>> };
      const lastThree = sent.input.slice(-3);
      expect(lastThree[0]).toEqual({ role: "assistant", content: [] });
      expect(lastThree[1]).toEqual({ role: "user", content: "" });
      expect(lastThree[2]).toEqual({ role: "developer", content: "" });
    } finally {
      vi.doUnmock("openai");
      vi.resetModules();
    }
  });
});
