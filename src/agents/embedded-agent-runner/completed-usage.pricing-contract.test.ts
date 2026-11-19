import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../../model-catalog/index.js";
import { prepareRemoteModelCatalogStartupSnapshot } from "../../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../../model-catalog/remote-overlay.test-support.js";
import { isInstalledPluginEnabled } from "../../plugins/installed-plugin-index.js";
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";
import { resolveModelCostConfig } from "../../utils/usage-format.js";
import { MODELS_JSON_STATE } from "../models-config-state.js";
import { buildCompletedAgentUsageMeta, mergeCompletedAgentUsage } from "./completed-usage.js";
import type { EmbeddedAgentMeta } from "./types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

// Every bundled row, priced by a hosted catalog newer than the build, records that price even
// when the transport reported its all-zero placeholder cost (a discovery or manifest zero).
const HOSTED_ONLY_MODEL = "hosted-only-live-model";
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const transportUsage = () => ({
  input: 1_000_000,
  output: 1_000_000,
  total: 2_000_000,
  cost: { ...ZERO, total: 0 },
});

type HostedRow = { provider: string; id: string; input: number; output: number };

async function recordedTurnCost(config: OpenClawConfig, provider: string, model: string) {
  const usage = createUsageAccumulator();
  const diagnosticUsage = createUsageAccumulator();
  await mergeCompletedAgentUsage({
    usage,
    diagnosticUsage,
    agentMetas: [{ provider, model, usage: transportUsage() } as EmbeddedAgentMeta],
    config,
  });
  return buildCompletedAgentUsageMeta(usage, diagnosticUsage).costUsd;
}

describe("recorded turn cost over every bundled and hosted row", () => {
  const config: OpenClawConfig = {};
  const hosted: HostedRow[] = [];

  beforeAll(async () => {
    MODELS_JSON_STATE.costCache.clear();
    setRemoteModelCatalogOverlaySourcesForTest();
    const snapshot = await resolvePluginMetadataSnapshotAsync({ config, env: process.env });
    const registry = {
      diagnostics: [],
      plugins: snapshot.manifestRegistry.plugins.filter((plugin) =>
        isInstalledPluginEnabled(snapshot.index, plugin.id, config),
      ),
    };
    const providers = new Map<string, boolean>();
    for (const row of planEffectiveModelCatalogRows({ registry, config }).rows) {
      providers.set(row.provider, providers.get(row.provider) || row.id.includes("/"));
      hosted.push({ provider: row.provider, id: row.id, input: 0, output: 0 });
    }
    // A live-listed id that no bundled manifest knows, shaped like the provider's own ids.
    for (const [provider, vendorIds] of providers) {
      const id = vendorIds ? `fixture-vendor/${HOSTED_ONLY_MODEL}` : HOSTED_ONLY_MODEL;
      hosted.push({ provider, id, input: 0, output: 0 });
    }
    // A refreshable gateway that declares no static rows still owns its hosted prices.
    providers.set("vercel-ai-gateway", true);
    hosted.push({
      provider: "vercel-ai-gateway",
      id: `fixture-vendor/${HOSTED_ONLY_MODEL}`,
      input: 0,
      output: 0,
    });
    hosted.forEach((row, index) => {
      row.input = 1 + (index % 7);
      row.output = 2 + (index % 11);
    });
    const bundle = {
      schemaVersion: 3,
      generatedAt: 200,
      sourceCommit: "pricing-contract",
      providers: Object.fromEntries([...providers.keys()].map((provider) => [provider, {}])),
      models: hosted.map(({ provider, id, input, output }) => ({
        provider,
        id,
        name: id,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
        pricing: {
          status: "known",
          currency: "USD",
          unit: "million_tokens",
          source: "modelsDev",
          input,
          output,
          cacheRead: 0,
          cacheWrite: 0,
        },
      })),
    };
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 100,
      readStoredCatalog: () => ({
        id: 1,
        source_url: "https://catalog.openclaw.ai/models/v3/catalog.json",
        bundle_json: JSON.stringify(bundle),
        generated_at: 200,
        min_version: null,
        etag: null,
        last_modified: null,
        checked_at: 200,
      }),
    });
    await prepareRemoteModelCatalogStartupSnapshot();
  });

  afterAll(() => {
    setRemoteModelCatalogOverlaySourcesForTest();
    MODELS_JSON_STATE.costCache.clear();
  });

  it("records the hosted price, never the placeholder zero", async () => {
    expect(hosted.length).toBeGreaterThan(300);
    const wrong: string[] = [];
    for (const row of hosted) {
      const expected = row.input + row.output;
      const recorded = await recordedTurnCost(config, row.provider, row.id);
      // The transport bills from this runtime answer; a manifest or discovery zero yields to it.
      const runtime = await resolveModelCostConfig({
        provider: row.provider,
        model: row.id,
        config,
        runtimeCost: ZERO,
      });
      if (
        recorded === undefined ||
        Math.abs(recorded - expected) > 1e-9 ||
        runtime?.input !== row.input ||
        runtime.output !== row.output
      ) {
        wrong.push(`${row.provider}/${row.id}: recorded ${recorded}, runtime ${runtime?.input}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps an authored zero price at $0", async () => {
    const row = expectDefined(hosted[0], "first hosted row");
    const authored = {
      models: {
        providers: {
          [row.provider]: {
            baseUrl: "https://example.test/v1",
            models: [{ id: row.id, cost: ZERO }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(await recordedTurnCost(authored, row.provider, row.id)).toBe(0);
  });
});
