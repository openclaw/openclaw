import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import {
  dualRoutes,
  platformRoute,
  routeResolverFactory,
  subscriptionRoute,
} from "./model-auth-availability.test-support.js";
import {
  createModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
} from "./model-catalog-decisions.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import * as openaiRoutes from "./openai-model-routes.js";

const entry: ModelCatalogEntry = { provider: "openai", id: "gpt-5.4", name: "GPT" };
const config: OpenClawConfig = {
  plugins: { entries: { codex: { enabled: true } } },
  agents: { defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } } } },
};
const metadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
});
function nativeOwner(complete: boolean, loggedIn: boolean, isCurrent = () => true, cfg = config) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "codex",
    source: "fixture",
    harness: {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("Catalog reads must not execute a model");
      },
    },
  });
  return createModelCatalogDecisions({
    cfg,
    agentId: "main",
    agentDir: "/tmp/catalog-agent",
    workspaceDir: "/tmp/catalog-workspace",
    snapshot: { entries: [entry], routeVariants: [entry] },
    metadataSnapshot: metadata,
    preparedAuthStore: { version: 1, profiles: {} },
    preparedRuntimeAuthModes: loggedIn ? { codex: { source: "native", mode: "api_key" } } : {},
    preparedSyntheticAuthComplete: complete,
    pluginRegistry: registry,
    isCurrent,
    routeResolverFactory: routeResolverFactory(dualRoutes),
  });
}

describe("captured model decisions", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])(
    "preserves provider auth for a non-CLI harness (authenticated=%s)",
    async (authenticated) => {
      const model = { provider: "github-copilot", id: "fixture-model", name: "Fixture model" };
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "copilot",
        source: "fixture",
        harness: {
          id: "copilot",
          label: "Copilot",
          supports: () => ({ supported: true }),
          async runAttempt() {
            throw new Error("Catalog reads must not execute a model");
          },
        },
      });
      const owner = createModelCatalogDecisions({
        cfg: { plugins: { entries: { copilot: { enabled: true } } } },
        agentId: "main",
        agentDir: "/tmp/copilot-agent",
        workspaceDir: "/tmp/copilot-workspace",
        snapshot: { entries: [model], routeVariants: [model] },
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "github-copilot", providers: ["github-copilot"] }, { id: "copilot" }],
        }),
        preparedAuthStore: {
          version: 1,
          profiles: authenticated
            ? {
                "github-copilot:work": {
                  type: "token",
                  provider: "github-copilot",
                  token: "fixture-token",
                },
              }
            : {},
        },
        preparedSyntheticAuthComplete: true,
        pluginRegistry: registry,
        isCurrent: () => true,
      });
      const choices = await owner.runtimeChoices(model);
      if (authenticated) {
        expect(await owner.evaluateEntry(model, undefined, "copilot")).toMatchObject({
          availability: true,
          selectedProfileId: "github-copilot:work",
        });
        expect(choices).toContain("copilot");
      } else {
        expect(choices).toBeUndefined();
      }
    },
  );

  it.each([undefined, "auto"])(
    "keeps native availability and runtime together under %s policy",
    async (runtime) => {
      vi.spyOn(openaiRoutes, "resolveOpenAIModelRoutes").mockImplementation(({ api }) => ({
        ...dualRoutes,
        defaultRuntimeId: api ? "openclaw" : "codex",
      }));
      const cfg: OpenClawConfig = {
        plugins: config.plugins,
        ...(runtime
          ? {
              agents: {
                defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: runtime } } } },
              },
            }
          : {}),
      };
      const owner = nativeOwner(true, true, () => true, cfg);
      const evaluation = await owner.evaluateEntry(entry);
      expect(evaluation).toMatchObject({
        availability: true,
        runtimeAuth: { id: "codex", source: "native" },
      });
      expect(
        resolveCatalogDecisionRuntime({
          cfg,
          agentId: "main",
          entry,
          evaluation,
          pluginRegistry: owner.pluginRegistry,
        }),
      ).toEqual({ id: "codex", source: "implicit" });
      expect(resolveCatalogDecisionRuntime({ cfg, agentId: "main", entry, evaluation })).toEqual({
        id: "codex",
        source: "implicit",
      });
    },
  );

  it("keeps an explicit host runtime from borrowing native authentication", async () => {
    const cfg: OpenClawConfig = {
      plugins: config.plugins,
      agents: {
        defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } } },
      },
    };
    const owner = nativeOwner(true, true, () => true, cfg);
    const evaluation = await owner.evaluateEntry(entry);
    expect(evaluation.availability).not.toBe(true);
    expect(evaluation.runtimeAuth).toBeUndefined();
    expect(
      resolveCatalogDecisionRuntime({
        cfg,
        agentId: "main",
        entry,
        evaluation,
        pluginRegistry: owner.pluginRegistry,
      }),
    ).toEqual({ id: "openclaw", source: "model" });
  });

  it("keeps ordinary host authentication distinct from native login", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "synthetic-host-key",
            models: [],
          },
        },
      },
    };
    const owner = nativeOwner(true, false, () => true, cfg);
    const evaluation = await owner.evaluateEntry(entry);
    expect(evaluation.availability).toBe(true);
    expect(evaluation.runtimeAuth).toBeUndefined();
    expect(evaluation.selectedRoute).toMatchObject(platformRoute);
    expect(evaluation.selectedAuthMode).toBe("api_key");
    expect(
      resolveCatalogDecisionRuntime({
        cfg,
        agentId: "main",
        entry,
        evaluation,
        pluginRegistry: owner.pluginRegistry,
      }),
    ).toEqual({ id: "codex", source: "implicit" });
  });

  it("offers only the native runtime when no host credential exists", async () => {
    expect(await nativeOwner(true, true).runtimeChoices(entry)).toEqual(["codex"]);
  });

  it("rechecks physical route evidence after resolving an uncatalogued reference", async () => {
    const owner = createModelCatalogDecisions({
      cfg: {},
      agentId: "main",
      workspaceDir: "/tmp/catalog-workspace",
      snapshot: { entries: [], routeVariants: [] },
      metadataSnapshot: metadata,
      preparedAuthStore: {
        version: 1,
        profiles: {
          "openai:platform": { type: "api_key", provider: "openai", key: "synthetic-key" },
        },
      },
      routeResolverFactory: () => (ref) => ({
        ...dualRoutes,
        routes: ref.observedRoutes?.some((route) => route.api === subscriptionRoute.api)
          ? [subscriptionRoute]
          : [platformRoute],
      }),
    });
    expect(
      await owner.evaluateEntry({ provider: entry.provider, id: entry.id }, undefined, "openclaw"),
    ).toMatchObject({ availability: true, selectedProfileId: "openai:platform" });
    expect(
      await owner.evaluateEntry(
        { ...entry, api: subscriptionRoute.api, baseUrl: subscriptionRoute.baseUrl },
        undefined,
        "openclaw",
      ),
    ).toMatchObject({ availability: false });
  });

  it("distinguishes unknown choices from authoritative empty choices", async () => {
    expect(await nativeOwner(false, false).runtimeChoices(entry)).toBeUndefined();
    expect(await nativeOwner(true, false).runtimeChoices(entry)).toEqual([]);
  });

  it("rejects a replaced generation instead of returning its old choices", async () => {
    let current = true;
    const owner = nativeOwner(true, true, () => current);
    expect(await owner.runtimeChoices(entry)).toEqual(["codex"]);
    current = false;
    await expect(owner.runtimeChoices(entry)).rejects.toThrow("Model catalog changed");
  });

  it("keeps a different provider's account pin out of the selected route", async () => {
    const owner = createModelCatalogDecisions({
      cfg: {},
      agentId: "main",
      workspaceDir: "/tmp/catalog-workspace",
      snapshot: { entries: [entry], routeVariants: [entry] },
      metadataSnapshot: metadata,
      preferredProfileId: "anthropic:chosen",
      pinnedProfileId: "anthropic:chosen",
      profileProvider: "anthropic",
      preparedAuthStore: {
        version: 1,
        profiles: {
          "anthropic:chosen": { type: "api_key", provider: "anthropic", key: "synthetic-a" },
          "openai:chosen": { type: "api_key", provider: "openai", key: "synthetic-b" },
        },
      },
      routeResolverFactory: routeResolverFactory({ ...dualRoutes, routes: [platformRoute] }),
    });
    expect(await owner.evaluateEntry(entry, [entry], "openclaw")).toMatchObject({
      availability: true,
      selectedProfileId: "openai:chosen",
    });
  });

  it("retains native provenance and mode without blessing a same-name bearer credential", () => {
    expect(
      resolveUsableAgentCredentialModes({
        codex: {
          type: "api_key",
          key: "presence",
          nativeAuth: { runtime: "codex", mode: "oauth" },
        },
      }),
    ).toEqual({ codex: { source: "native", mode: "oauth" } });
    expect(
      resolveUsableAgentCredentialModes({ codex: { type: "api_key", key: "configured-bearer" } }),
    ).toEqual({ codex: "api_key" });
  });
});
