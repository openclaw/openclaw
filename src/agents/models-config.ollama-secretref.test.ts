import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-shared.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { OpenClawPluginDefinition, ProviderPlugin } from "../plugins/types.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";
import { encodePluginModelCatalogRelativePath } from "./plugin-model-catalog.js";

const discovery = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

describe("registered Ollama catalog", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeAll(async () => {
    const { default: plugin } = await loadBundledPluginFacade<{
      default: OpenClawPluginDefinition;
    }>({ pluginId: "ollama", artifactBasename: "index.js" });
    expectDefined(
      plugin.register,
      "Ollama public register",
    )(
      createTestPluginApi({
        id: "ollama",
        registrationMode: "discovery",
        registerProvider: (provider) => {
          if (provider.id === "ollama") {
            discovery.providers.push(provider);
          }
        },
      }),
    );
  });
  afterEach(() => {
    clearLiveCatalogCacheForTests();
    vi.unstubAllGlobals();
  });

  const remote = "https://ollama-profile.example/v1";
  const local = "http://127.0.0.1:11434";
  const resolved = "resolved-ollama-profile-fixture";
  it.each([
    ["profile", remote, false, resolved],
    ["profile", remote, true, resolved],
    ["profile", local, true, resolved],
    ["config", local, false, "OLLAMA_API_KEY"],
    ["config", local, true, "ollama-local"],
    ["config", "http://127.0.0.1:11435", false, NON_ENV_SECRETREF_MARKER],
  ] as const)(
    "keeps %s refs out of writable plans at %s (explicit=%s, value=%s)",
    async (owner, baseUrl, explicitModels, runtimeKey) => {
      const stateDir = tempDirs.make("ollama-catalog-ref-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, OLLAMA_API_KEY: undefined }, async () => {
        const agentDir = path.join(stateDir, "agent");
        const ref = { source: "store", provider: "default", id: "OLLAMA_DISCOVERY_KEY" } as const;
        const profile = {
          type: "api_key",
          provider: "ollama",
          keyRef: ref,
        } as const;
        const authStore: AuthProfileStore = {
          version: 1,
          profiles: owner === "profile" ? { "ollama:fixture": profile } : {},
        };
        if (owner === "profile") {
          setRuntimeAuthProfileStoreSnapshot(
            {
              version: 1,
              profiles: { "ollama:fixture": { ...profile, key: runtimeKey } },
            },
            agentDir,
          );
        }
        const model = {
          id: "fixture-model",
          name: "Fixture model",
          reasoning: false,
          input: ["text"] as ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        };
        const provider = { baseUrl, models: explicitModels ? [model] : [] };
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              ollama: { ...provider, ...(owner === "config" ? { apiKey: ref } : {}) },
            },
          },
        };
        const discoveryAuthConfig: OpenClawConfig =
          owner === "config"
            ? { models: { providers: { ollama: { ...provider, apiKey: runtimeKey } } } }
            : cfg;
        const authorization: Array<string | null> = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          authorization.push(new Headers(init?.headers).get("authorization"));
          const url = input instanceof Request ? input.url : input.toString();
          return Response.json(
            url.endsWith("/api/tags")
              ? { models: [{ name: model.id }] }
              : {
                  capabilities: ["completion", "tools"],
                  model_info: { "fixture.context_length": 8192 },
                },
          );
        });
        vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
        try {
          const plan = await planOpenClawModelsJson({
            context: {
              cfg,
              discoveryAuthConfig,
              sourceConfigForSecrets: cfg,
              agentDir,
              env: {},
              envFingerprint: {},
              pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
                plugins: [{ id: "ollama", providers: discovery.providers.map(({ id }) => id) }],
              }),
            },
            authStore,
            existingRaw: "",
            existingParsed: null,
          });
          const contents = expectDefined(
            plan.pluginCatalogWrites?.[encodePluginModelCatalogRelativePath("ollama")],
            "Ollama writable plugin catalog",
          );
          // Equal bytes do not make the source-derived marker secret material.
          if (runtimeKey !== NON_ENV_SECRETREF_MARKER) {
            expect(JSON.stringify(plan)).not.toContain(runtimeKey);
          }
          expect(JSON.stringify(plan)).not.toContain("discoveryApiKey");
          const catalog = JSON.parse(contents) as {
            providers: { ollama: { api: string; apiKey: string; models: Array<{ id: string }> } };
          };
          expect(catalog.providers.ollama.models.map(({ id }) => id)).toEqual([model.id]);
          expect(catalog.providers.ollama.api).toBe("ollama");
          // Explicit local catalogs intentionally select synthetic auth before profiles,
          // and that synthetic marker never reaches the local discovery request.
          const syntheticLocalAuth =
            owner === "profile" && explicitModels && baseUrl.startsWith("http://127.0.0.1");
          expect(catalog.providers.ollama.apiKey).toBe(
            syntheticLocalAuth ? "ollama-local" : NON_ENV_SECRETREF_MARKER,
          );
          expect(authorization).toEqual(
            syntheticLocalAuth ? [null, null] : [`Bearer ${runtimeKey}`, `Bearer ${runtimeKey}`],
          );
        } finally {
          // Close snapshot readers before the tracker removes their temporary owner.
          clearRuntimeAuthProfileStoreSnapshots();
        }
      });
    },
  );

  it("lists chat models pulled after setup, keeps setup model settings, and keeps setup models when listing fails", async () => {
    const stateDir = tempDirs.make("ollama-catalog-pull-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, OLLAMA_API_KEY: undefined }, async () => {
      const setupModel = {
        id: "qwen2.5:0.5b",
        name: "qwen2.5:0.5b",
        reasoning: false,
        input: ["text"] as ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
        // Documented workaround for local models that fail on tool schemas.
        compat: { supportsTools: false },
      };
      // Setup saves the models it found; later pulls must not need a config edit.
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            ollama: { baseUrl: local, api: "ollama", apiKey: "ollama-local", models: [setupModel] },
          },
        },
      };
      let installed: string[] | undefined = [setupModel.id, "qwen3:0.6b", "nomic-embed-text"];
      let tagsRequests = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith("/api/tags")) {
          tagsRequests += 1;
          return installed
            ? Response.json({ models: installed.map((name) => ({ name })) })
            : new Response("unavailable", { status: 503 });
        }
        return Response.json({
          capabilities: (typeof init?.body === "string" ? init.body : "").includes("nomic-embed")
            ? ["embedding"]
            : ["completion", "tools"],
          model_info: { "general.context_length": 8192 },
        });
      });
      vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
      const listedModels = async () => {
        const plan = await planOpenClawModelsJson({
          context: {
            cfg,
            discoveryAuthConfig: cfg,
            sourceConfigForSecrets: cfg,
            agentDir: path.join(stateDir, "agent"),
            env: {},
            envFingerprint: {},
            pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
              plugins: [{ id: "ollama", providers: discovery.providers.map(({ id }) => id) }],
            }),
          },
          authStore: { version: 1, profiles: {} },
          existingRaw: "",
          existingParsed: null,
        });
        const catalog: {
          providers: { ollama: { models: Array<{ id: string; compat?: unknown }> } };
        } = JSON.parse(
          expectDefined(
            plan.pluginCatalogWrites?.[encodePluginModelCatalogRelativePath("ollama")],
            "Ollama writable plugin catalog",
          ),
        );
        return catalog.providers.ollama.models.map(({ id, compat }) => ({ id, compat }));
      };

      // `/api/show` advertises tools for the setup model, but its configured compat still wins.
      expect(await listedModels()).toEqual([
        { id: setupModel.id, compat: { supportsTools: false } },
        { id: "qwen3:0.6b", compat: expect.objectContaining({ supportsTools: true }) },
      ]);
      installed = undefined;
      expect(await listedModels()).toEqual([
        { id: setupModel.id, compat: { supportsTools: false } },
      ]);
      expect(tagsRequests).toBe(2);
    });
  });
});
