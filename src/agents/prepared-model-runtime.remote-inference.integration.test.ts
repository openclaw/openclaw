import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runPublishModelCatalog } from "../../scripts/publish-model-catalog.mts";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveModelPricing, resolveModelPricingContext } from "../model-catalog/pricing.js";
import {
  captureRemoteModelCatalogStartupSnapshot,
  prepareRemoteModelCatalogStartupSnapshot,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { refreshRemoteModelCatalog } from "../model-catalog/remote-refresh.js";
import { readRemoteModelCatalogAsync } from "../model-catalog/remote-store.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveDecisionModelSetting } from "./decision-model-setting.js";
import { buildAllowedModelSet } from "./model-selection.js";
import {
  catalogInput,
  createCatalogFixture,
  HARNESS_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import {
  acquireAgentRunPreparedModelRuntime,
  applyRemoteModelCatalogUpdate,
  publishPreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
afterEach(() => setRemoteModelCatalogOverlaySourcesForTest());

it("carries published task facts through HTTP, SQLite and prepared role selection", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const route: Pick<ModelProviderConfig, "api" | "baseUrl"> = {
    api: "openai-completions",
    baseUrl: "https://worker-catalog.invalid/v1",
  };
  const nativeBaseUrl = "https://native-worker-catalog.invalid/v1";
  const manifestFile = path.join(fixture.root, "plugin/openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  // Installed transport owns the route, but cannot supply the task facts being proved.
  manifest.modelCatalog.providers = {
    [PROVIDER_ID]: {
      ...route,
      models: [{ id: "sqlite-model" }, { id: "native", baseUrl: nativeBaseUrl }],
    },
  };
  manifest.modelCatalog.discovery = { [PROVIDER_ID]: "static" };
  writeJsonFile(manifestFile, manifest);
  const inference = {
    chat: false,
    decision: {
      protocol: "fixture.decisions",
      input: ["text"],
      questions: { boolean: { probabilities: "boolean", abstention: true } },
      limits: { maxQuestions: 32 },
      billing: { unit: "tokens", source: "provider-catalog", usdPerMillion: { input: 0 } },
    },
  };
  const publisherRoot = path.join(fixture.root, "publisher");
  writeJsonFile(path.join(publisherRoot, "extensions/fixture/openclaw.plugin.json"), {
    providers: ["anthropic", "openai", PROVIDER_ID],
    modelCatalog: {
      providers: {
        anthropic: { models: [{ id: "chat-a" }] },
        openai: { models: Array.from({ length: 199 }, (_, i) => ({ id: `chat-${i}` })) },
        [PROVIDER_ID]: {
          ...route,
          models: [
            { id: "native", baseUrl: nativeBaseUrl, inference },
            { id: "dual", inference: { ...inference, chat: true } },
            { id: "free" },
            { id: "unknown" },
          ],
        },
      },
    },
    modelPricing: { providers: { [PROVIDER_ID]: { openCode: { provider: "upstream" } } } },
  });
  writeJsonFile(path.join(publisherRoot, "scripts/lib/recommended-models.json"), []);
  await runPublishModelCatalog({
    rootDir: publisherRoot,
    sourceCommit: "fixture",
    args: ["--pricing", "--out", "v1.json", "--out-v3", "v3.json"],
    fetchImpl: async (url) => {
      if (url !== "https://models.opencode.ai/api.json") {
        throw new Error("unexpected publisher source");
      }
      return Response.json({
        upstream: {
          id: "upstream",
          models: { free: { id: "free", cost: { input: 0, output: 0 } } },
        },
      });
    },
  });
  const bytes = fs.readFileSync(path.join(publisherRoot, "v3.json"));
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", etag: '"task-catalog"' });
      response.end(bytes);
    },
    async (baseUrl) => {
      const config: OpenClawConfig = {
        ...fixture.config,
        agents: {
          defaults: {
            ...fixture.config.agents.defaults,
            decisionModel: `${PROVIDER_ID}/native`,
            models: {
              ...fixture.config.agents.defaults.models,
              [`${PROVIDER_ID}/dual`]: { agentRuntime: { id: HARNESS_ID } },
            },
          },
        },
        models: {
          catalogRefresh: { url: `${baseUrl}/v3.json` },
          providers: {
            [PROVIDER_ID]: {
              ...route,
              models: [
                {
                  id: "dual",
                  name: "Dual",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
      };
      await withEnvAsync(fixture.env, async () => {
        setRemoteModelCatalogOverlaySourcesForTest({ bundledGeneratedAt: () => 1 });
        expect(await prepareRemoteModelCatalogStartupSnapshot()).toBeNull();
        const input = catalogInput({ ...fixture, config });
        const before = await publishPreparedModelRuntimeSnapshot(input, {
          provenance: "configured",
          catalogMode: "static",
        });
        expect(before.modelCatalog.entries.some((row) => row.id === "native")).toBe(false);
        expect(await refreshRemoteModelCatalog({ config, force: true })).toMatchObject({
          status: "updated",
          models: 204,
        });
        // A download is inert until the existing rows/pricing publication owner adopts it.
        expect(captureRemoteModelCatalogStartupSnapshot()).toBeNull();
        expect(await applyRemoteModelCatalogUpdate(() => config)).toBe("published");
        await using lease = await acquireAgentRunPreparedModelRuntime(input);
        lease.run(() => {
          const rows = lease.snapshot.modelCatalog.entries;
          expect(rows.find((row) => row.id === "native")?.inference).toEqual(inference);
          expect(rows.find((row) => row.id === "dual")?.inference).toEqual({
            ...inference,
            chat: true,
          });
          const allowed = buildAllowedModelSet({
            cfg: config,
            catalog: rows,
            defaultProvider: PROVIDER_ID,
            manifestPlugins: lease.snapshot.metadataSnapshot,
          });
          expect(allowed.allowedCatalog.some((row) => row.id === "native")).toBe(false);
          expect(allowed.allowedCatalog.some((row) => row.id === "dual")).toBe(true);
          expect(resolveDecisionModelSetting(config)).toEqual({
            provider: PROVIDER_ID,
            model: "native",
          });
          const pricing = resolveModelPricingContext(config);
          expect(resolveModelPricing(pricing, `${PROVIDER_ID}/free`)).toMatchObject({
            input: 0,
            output: 0,
          });
          expect(resolveModelPricing(pricing, `${PROVIDER_ID}/unknown`)).toBeUndefined();
        });
        const stored = await readRemoteModelCatalogAsync(captureOpenClawStateWorkerContext());
        const persisted = JSON.parse(stored!.bundle_json);
        expect(persisted.schemaVersion).toBe(3);
        expect(
          persisted.models.find((row: { id: string }) => row.id === "native").inference,
        ).toEqual(inference);
      });
    },
  );
});
