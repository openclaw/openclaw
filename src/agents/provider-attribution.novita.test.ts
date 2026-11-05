import path from "node:path";
import { createNodeLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { assert, describe, expect, it } from "vitest";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

// Read the public manifest without loading the provider runtime or operator state.
const rootDir = path.resolve("extensions/novita");
const registry = loadPluginManifestRegistryCore({
  installRecords: {},
  candidates: [
    { idHint: "novita", rootDir, source: path.join(rootDir, "index.ts"), origin: "bundled" },
  ],
});
const owners = createPluginMetadataSnapshotFixture(registry).owners;
const catalog = registry.plugins[0]?.modelCatalog?.providers?.novita;
assert(catalog);
assert(catalog.models.length > 0);
const baseUrl = catalog.baseUrl;
assert(baseUrl);

describe("Novita chat completions request compatibility", () => {
  it.each([
    ...catalog.models.map(({ id, reasoning }) => ({ id, reasoning, provider: "novita" })),
    { id: "configured-reasoning-model", reasoning: true, provider: "novita" },
    { id: "discovered-reasoning-model", reasoning: true, provider: "novita-ai" },
    { id: "discovered-reasoning-model", reasoning: true, provider: "novitaai" },
    { id: "custom-provider-model", reasoning: true, provider: "custom" },
  ])("sends system and max_tokens for $provider/$id", async ({ id, reasoning, provider }) => {
    const requests: unknown[] = [];
    const runtime = createNodeLlmRuntime(undefined, {
      resolveProviderRequestCapabilities: (input) =>
        resolveProviderRequestCapabilities({ ...input, providerMetadataOwners: owners }),
      buildModelFetch: () => async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://api.novita.ai/openai/v1/chat/completions");
        requests.push(await request.json());
        return new Response(
          'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    registerBuiltInApiProviders(runtime.registry);

    const result = await runtime.completeSimple(
      makeProviderModelFixture<"openai-completions">({
        id,
        provider,
        api: "openai-completions",
        baseUrl,
        reasoning,
      }),
      {
        systemPrompt: "Follow instructions.",
        messages: [{ role: "user", content: "Reply with ok.", timestamp: 1 }],
      },
      { apiKey: "test-key", reasoning: "low", maxTokens: 200 },
    );

    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: id,
      messages: [
        { role: "system", content: "Follow instructions." },
        { role: "user", content: "Reply with ok." },
      ],
      reasoning_effort: "low",
      max_tokens: 200,
    });
    expect(requests[0]).not.toHaveProperty("max_completion_tokens");
  });
});
