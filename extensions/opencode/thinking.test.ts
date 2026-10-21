import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { buildOpencodeZenLiveProviderConfig } from "./provider-catalog.js";

const EFFORTS = ["off", "low", "high", "max"] as const;

afterEach(() => {
  vi.restoreAllMocks();
  clearLiveCatalogCacheForTests();
});

describe.each(["offline", "refreshed"] as const)("Kimi K3 %s catalog thinking", (catalog) => {
  it.each(EFFORTS)("sends %s through both registered completion paths", async (reasoning) => {
    const provider = await registerSingleProviderPlugin(plugin);
    const config = await buildOpencodeZenLiveProviderConfig(
      catalog === "offline"
        ? {}
        : {
            apiKey: "test-key",
            fetchGuard: async ({ url }) => ({
              finalUrl: url,
              release: async () => {},
              response: Response.json(
                url.endsWith("/models")
                  ? { data: [{ id: "kimi-k3" }] }
                  : {
                      opencode: {
                        id: "opencode",
                        api: "https://opencode.ai/zen/v1",
                        npm: "@ai-sdk/openai-compatible",
                        models: {
                          "kimi-k3": {
                            id: "kimi-k3",
                            name: "Kimi K3",
                            reasoning: true,
                            tool_call: true,
                            modalities: { input: ["text"], output: ["text"] },
                            limit: { context: 256_000, output: 32_000 },
                            cost: { input: 0.5, output: 2.8 },
                            reasoning_options: [{ type: "effort", values: ["max"] }],
                          },
                        },
                      },
                    },
              ),
            }),
          },
    );
    const row = config.models.find((entry) => entry.id === "kimi-k3");
    if (!row) {
      throw new Error("Kimi K3 missing from Zen catalog");
    }
    const model: Model<"openai-completions"> = {
      ...row,
      provider: provider.id,
      api: "openai-completions",
      baseUrl: config.baseUrl,
      input: row.input.filter((kind) => kind === "text" || kind === "image"),
    };
    const requests: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://opencode.ai/zen/v1/chat/completions");
      requests.push(await request.json());
      return new Response(
        `data: ${JSON.stringify({ id: "kimi-test", choices: [{ index: 0, delta: { content: "391" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    for (const underlying of [streamSimple, createOpenAICompletionsTransportStreamFn()]) {
      const streamFn = provider.wrapStreamFn?.({
        provider: provider.id,
        modelId: model.id,
        model,
        thinkingLevel: reasoning,
        streamFn: underlying,
      });
      if (!streamFn) {
        throw new Error("Registered Zen stream wrapper missing");
      }
      const stream = await streamFn(
        model,
        { messages: [{ role: "user", content: "What is 17 times 23?", timestamp: 0 }] },
        { apiKey: "test-key", reasoning, maxTokens: 512, sessionId: "kimi-thinking-test" },
      );
      const result = await stream.result();
      expect(result.stopReason, result.errorMessage).toBe("stop");
    }
    expect(requests).toEqual(
      ["direct", "managed"].map(() =>
        expect.objectContaining({
          model: "kimi-k3",
          reasoning_effort: reasoning === "off" ? "none" : reasoning,
        }),
      ),
    );
    expect(provider.resolveThinkingProfile?.({ ...model, modelId: model.id })).toEqual({
      levels: EFFORTS.map((id) => ({ id })),
      defaultLevel: "high",
    });
  });
});
