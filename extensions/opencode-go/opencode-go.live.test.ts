import { randomUUID } from "node:crypto";
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveProviderRequestPolicy } from "openclaw/plugin-sdk/provider-http";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import {
  buildOpencodeGoLiveProviderConfig,
  listOpencodeGoModelCatalogEntries,
} from "./provider-catalog.js";

const OPENCODE_GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";
const OPENCODE_API_KEY =
  process.env.OPENCODE_API_KEY?.trim() || process.env.OPENCODE_ZEN_API_KEY?.trim() || "";
const LIVE = isLiveTestEnabled(["OPENCODE_GO_LIVE_TEST"]) && OPENCODE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

type ModelsResponse = { data?: Array<{ id?: unknown; object?: unknown }> };

describeLive("OpenCode Go live dynamic catalog", () => {
  it("discovers every advertised model except inactive metadata rows", async () => {
    const response = await fetch(OPENCODE_GO_MODELS_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${OPENCODE_API_KEY}`,
        "accept-encoding": "identity",
      },
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as ModelsResponse;
    const liveIds = (body.data ?? [])
      .filter((row) => row.object === undefined || row.object === "model")
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim().toLowerCase())
      .toSorted();
    const live = await buildOpencodeGoLiveProviderConfig({
      apiKey: OPENCODE_API_KEY,
      discoveryApiKey: OPENCODE_API_KEY,
    });
    const discoveredIds = live.models.map((model) => model.id).toSorted();
    // Listed ids without public metadata stay visible; only inactive metadata rows hide them.
    const inactiveIds = new Set(
      listOpencodeGoModelCatalogEntries()
        .filter((row) => row.status)
        .map((row) => row.id.toLowerCase()),
    );

    expect(discoveredIds.length).toBeGreaterThan(0);
    expect(new Set(discoveredIds).size).toBe(discoveredIds.length);
    expect(discoveredIds).toEqual([...new Set(liveIds)].filter((id) => !inactiveIds.has(id)));
  }, 30_000);

  it.each([
    ["glm-5.3-flash", "openai-completions"],
    ["gpt-5.6-luna", "openai-responses"],
    ["qwen3.8-flash", "anthropic-messages"],
    ["gemini-4-argon-contributor", "google-generative-ai"],
  ] as const)(
    "runs discovered %s through %s",
    async (modelId, api) => {
      const provider = await buildOpencodeGoLiveProviderConfig({ apiKey: OPENCODE_API_KEY });
      const row = provider.models.find((model) => model.id === modelId);
      expect(row?.api).toBe(api);
      expect(row?.baseUrl).toMatch(/^https:\/\/opencode\.ai\/inference\/go\//);
      if (!row || row.api !== api || !row.contextWindow) {
        throw new Error(`OpenCode Go catalog lacks the ${modelId} ${api} route`);
      }
      const input = row.input.filter((kind) => kind === "text" || kind === "image");
      expect(input).toEqual(row.input);
      const model: Model<typeof api> = {
        ...row,
        api: row.api,
        contextWindow: row.contextWindow,
        provider: "opencode-go",
        baseUrl: row.baseUrl ?? provider.baseUrl,
        input,
      };
      const registeredProvider = await registerSingleProviderPlugin(plugin);
      expect(
        resolveProviderRequestPolicy({
          provider: model.provider,
          api: model.api,
          baseUrl: model.baseUrl,
          capability: "llm",
          transport: "stream",
        }).attributionHeaders?.["User-Agent"],
      ).toMatch(/^openclaw\//);
      const sessionId = `opencode-go-live-${randomUUID()}`;
      const turnState = registeredProvider.resolveTransportTurnState?.({
        provider: model.provider,
        modelId: model.id,
        model,
        sessionId,
        turnId: randomUUID(),
        attempt: 1,
        transport: "stream",
      });
      const result = await completeSimple(
        model,
        { messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }] },
        {
          apiKey: OPENCODE_API_KEY,
          maxTokens: 512,
          reasoning: "low",
          sessionId,
          headers: turnState?.headers,
        },
      );
      if (result.stopReason === "error") {
        // Contributor models require a workspace opt-in to training on request data; this
        // refusal still proves the route, auth, and model id reached Go.
        if (
          modelId.endsWith("-contributor") &&
          result.errorMessage?.includes("trains on request data")
        ) {
          return;
        }
        throw new Error(result.errorMessage || "OpenCode Go inference returned an error");
      }
      expect(extractNonEmptyAssistantText(result.content)).toMatch(/^ok[.!]?$/i);
    },
    120_000,
  );
});
