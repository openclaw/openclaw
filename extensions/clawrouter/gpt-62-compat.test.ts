import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buildClawRouterProviderConfig,
  prepareClawRouterRequestModel,
} from "./provider-catalog.js";

beforeEach(clearLiveCatalogCacheForTests);
afterEach(() => vi.restoreAllMocks());

it.each(["gpt-6.2-astra", "gpt-6.2-sol"])(
  "keeps %s's native request contract on its admitted router route",
  async (upstream) => {
    // Fixed external I/O: no provider auth store or real router connection is involved.
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async () => ({
      response: Response.json({
        providers: [
          {
            id: "openai",
            displayName: "OpenAI",
            openaiCompatible: true,
            nativeBaseUrl: "/v1/native/openai",
            routes: [],
            models: [
              {
                id: "openai/" + upstream,
                upstream,
                capabilities: ["llm.responses"],
                input: ["text", "image"],
                supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
              },
            ],
          },
        ],
      }),
      finalUrl: "https://clawrouter.example/v1/catalog",
      release: async () => undefined,
    }));
    const catalog = await buildClawRouterProviderConfig({
      apiKey: "synthetic-key",
      baseUrl: "https://clawrouter.example",
    });
    const row = catalog.models[0];
    if (!row) {
      throw new Error("missing admitted model");
    }
    const model = prepareClawRouterRequestModel({
      ...row,
      provider: "clawrouter",
      api: "openai-responses",
      baseUrl: row.baseUrl ?? catalog.baseUrl,
    } as Model);
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      urls.push(request.url);
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json(
        { error: { message: "synthetic capture", type: "invalid_request_error" } },
        { status: 400 },
      );
    });
    await (
      await createOpenAIResponsesTransportStreamFn()(
        model,
        {
          messages: [
            { role: "user", content: "Call echo for this synthetic value.", timestamp: 0 },
          ],
          tools: [
            {
              name: "echo",
              description: "Synthetic echo",
              parameters: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
        },
        {
          apiKey: "synthetic-key",
          reasoning: "low",
          temperature: 0.3,
          cacheRetention: "long",
        },
      )
    ).result();
    expect(row.input).toEqual(["text", "image"]);
    expect(row.compat).toMatchObject({ supportsTemperature: false });
    expect(urls).toEqual(["https://clawrouter.example/v1/responses"]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model: "openai/" + upstream,
      reasoning: { effort: "low" },
      tools: [{ type: "function", name: "echo" }],
    });
    expect(bodies[0]).not.toHaveProperty("temperature");
    // An unopted proxy must not gain official cache controls from its upstream ID.
    expect(bodies[0]).not.toHaveProperty("prompt_cache_retention");
    expect(bodies[0]).not.toHaveProperty("prompt_cache_options");
  },
);
