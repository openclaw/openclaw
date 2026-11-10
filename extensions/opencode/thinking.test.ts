import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { buildOpencodeZenLiveProviderConfig } from "./provider-catalog.js";

const EFFORTS = ["off", "low", "high", "max"] as const;
const BASE_URL = "https://opencode.ai/zen/v1";
const upstreamModel = {
  id: "kimi-k3",
  reasoning: true,
  limit: { context: 256_000, output: 32_000 },
  reasoning_options: [{ type: "effort", values: ["max"] }],
};
const metadata = { opencode: { id: "opencode", models: { "kimi-k3": upstreamModel } } };

afterEach(() => {
  vi.restoreAllMocks();
  clearLiveCatalogCacheForTests();
});

describe.each(["offline", "refreshed"] as const)("Kimi K3 %s catalog thinking", (catalog) => {
  it.each(EFFORTS)("sends %s through both registered completion paths", async (reasoning) => {
    const provider = await registerSingleProviderPlugin(plugin);
    const config = await buildOpencodeZenLiveProviderConfig({
      apiKey: catalog === "refreshed" ? "test-key" : undefined,
      fetchGuard: async ({ url }) => ({
        finalUrl: url,
        release: async () => {},
        response: Response.json(url.endsWith("/models") ? { data: [{ id: "kimi-k3" }] } : metadata),
      }),
    });
    const row = config.models.find((entry) => entry.id === "kimi-k3");
    assert(row, "Kimi K3 missing from Zen catalog");
    const model: Model<"openai-completions"> = {
      ...row,
      provider: provider.id,
      api: "openai-completions",
      baseUrl: config.baseUrl,
      input: row.input.filter((kind) => kind === "text" || kind === "image"),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${BASE_URL}/chat/completions`);
      expect(await request.json()).toMatchObject({
        model: "kimi-k3",
        reasoning_effort: reasoning === "off" ? "none" : reasoning,
      });
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
      assert(streamFn, "Registered Zen stream wrapper missing");
      const stream = await streamFn(
        model,
        { messages: [{ role: "user", content: "What is 17 times 23?", timestamp: 0 }] },
        { apiKey: "test-key", reasoning, maxTokens: 512, sessionId: "kimi-thinking-test" },
      );
      const result = await stream.result();
      expect(result.stopReason, result.errorMessage).toBe("stop");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.resolveThinkingProfile?.({ ...model, modelId: model.id })).toEqual({
      levels: EFFORTS.map((id) => ({ id })),
      defaultLevel: "high",
    });
  });
});
