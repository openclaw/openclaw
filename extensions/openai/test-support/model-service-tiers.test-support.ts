import { expect, it } from "vitest";
import { OPENAI_CODEX_RESPONSES_BASE_URL } from "../base-url.js";
import type { runCatalogWithFetchGuard as RunCatalog } from "./live-catalog.test-support.js";

/** Register in the provider suite so its auth mocks and cache-reset hooks remain authoritative. */
export function registerOpenAIServiceTierCatalogTests({
  runCatalogWithFetchGuard,
}: {
  runCatalogWithFetchGuard: typeof RunCatalog;
}): void {
  it("keeps service tiers with the authenticated model/account, never fallback metadata", async () => {
    const result = await runCatalogWithFetchGuard({
      fetchGuard: async ({ url }) => ({
        response: Response.json({
          models: [
            {
              slug: "synthetic-tier-model",
              service_tiers: [{ id: " ultrafast " }, { id: "priority" }],
            },
            { slug: "synthetic-empty", service_tiers: [] },
            { slug: "synthetic-unknown" },
            { slug: "synthetic-invalid", service_tiers: [{ id: 12 }] },
          ],
        }),
        finalUrl: url,
        release: async () => {},
      }),
      auth: {
        mode: "oauth",
        apiKey: "synthetic-tier-token",
        profileId: "openai:tiers",
        source: "profile",
      },
      accountId: "synthetic-tier-account",
    });
    expect(result.outcomes).toEqual([
      {
        provider: "openai",
        profileId: "openai:tiers",
        status: "ready",
        modelServiceTiers: [
          ["synthetic-tier-model", ["ultrafast", "priority"]],
          ["synthetic-empty", []],
        ].map(([modelId, serviceTiers]) => ({
          modelId,
          runtimeId: "codex",
          api: "openai-chatgpt-responses",
          baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
          serviceTiers,
        })),
        listedModelIds: [
          "synthetic-tier-model",
          "synthetic-empty",
          "synthetic-unknown",
          "synthetic-invalid",
        ],
      },
    ]);
    expect(result.provider.models.every((model) => !("serviceTiers" in model))).toBe(true);
    const other = await runCatalogWithFetchGuard({
      auth: {
        mode: "oauth",
        apiKey: "synthetic-other-token",
        profileId: "openai:other",
        source: "profile",
      },
      accountId: "synthetic-other-account",
      fetchGuard: async ({ url }) => ({
        response: new Response("unavailable", { status: 503 }),
        finalUrl: url,
        release: async () => {},
      }),
    });
    expect(other.outcomes).toEqual([
      { provider: "openai", profileId: "openai:other", status: "unavailable" },
    ]);
  });
}
