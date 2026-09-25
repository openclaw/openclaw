import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { noteCommittedSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
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
    expect(evaluation.selectedAuthMode).toBe("api-key");
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

describe("catalog decisions with prepared CLI auth directories", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    cliBackendsTesting.resetDepsForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const cliMetadata = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "anthropic",
        providers: ["anthropic"],
        cliBackends: ["claude-cli"],
        providerAuthChoices: [
          {
            provider: "anthropic",
            method: "cli",
            choiceId: "anthropic-cli",
            deprecatedChoiceIds: ["claude-cli"],
            choiceLabel: "Anthropic Claude CLI",
          },
        ],
      },
    ],
  });

  function storedChoice(cli: boolean): AuthProfileStore {
    return {
      version: 1,
      profiles: {
        selected: cli
          ? {
              type: "oauth",
              provider: "claude-cli",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: Date.now() + 600_000,
            }
          : { type: "api_key", provider: "anthropic", key: "synthetic-key" },
      },
      order: { anthropic: ["selected"] },
    };
  }

  function decisionOwner(cfg: OpenClawConfig, agentId: string, workspaceDir: string) {
    return createModelCatalogDecisions({
      cfg,
      agentId,
      workspaceDir,
      snapshot: { entries: [], routeVariants: [] },
      metadataSnapshot: cliMetadata,
      preparedAuthStore: { version: 1, profiles: {} },
      preparedRuntimeAuthModes: { "claude-cli": "oauth" },
      preparedSyntheticAuthComplete: true,
    });
  }

  function readRow(owner: ReturnType<typeof decisionOwner>, id: string) {
    return owner.evaluateEntry({ provider: "anthropic", id });
  }

  it("reads replaced stored CLI choices for new rows in one decisions instance", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" });
      const cfg: OpenClawConfig = {
        agents: { entries: { worker: { agentDir: state.path("custom-worker") } } },
      };
      const orderStore: AuthProfileStore = {
        ...storedChoice(true),
        profiles: {
          ...storedChoice(true).profiles,
          direct: { type: "api_key", provider: "anthropic", key: "synthetic-direct-key" },
        },
      };
      setRuntimeAuthProfileStoreSnapshot(orderStore, state.path("custom-worker"));
      const owner = decisionOwner(cfg, "worker", state.workspaceDir);
      expect(await readRow(owner, "before-order-change")).toMatchObject({
        availability: true,
        evidence: "runtime",
        selectedAuthMode: "oauth",
      });

      setRuntimeAuthProfileStoreSnapshot(
        { ...orderStore, order: { anthropic: ["direct"] } },
        state.path("custom-worker"),
      );
      // New keys bypass the intentional completed-row decision memoization.
      expect((await readRow(owner, "after-order-change")).evidence).not.toBe("runtime");
      setRuntimeAuthProfileStoreSnapshot(orderStore, state.path("custom-worker"));
      expect(await readRow(owner, "after-order-restored")).toMatchObject({
        availability: true,
        evidence: "runtime",
      });
    });
  });

  it("follows shared ownership relocation after preparing a legacy inherited directory", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" });
      const legacyDir = state.path("custom-inherited");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { authInheritance: { agentId: "legacy" } },
          entries: { legacy: { agentDir: legacyDir }, worker: {} },
        },
      };
      setRuntimeAuthProfileStoreSnapshot(storedChoice(false), legacyDir);
      const owner = decisionOwner(cfg, "worker", state.workspaceDir);
      expect((await readRow(owner, "before-relocation")).evidence).not.toBe("runtime");

      noteCommittedSharedAuthStoreOwnership({ location: "state-db" });
      setRuntimeAuthProfileStoreSnapshot(storedChoice(true));
      expect(await readRow(owner, "after-relocation")).toMatchObject({
        availability: true,
        evidence: "runtime",
        selectedAuthMode: "oauth",
      });
    });
  });

  it("keeps custom agent paths separate and prepares a changed path for a new decisions instance", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" });
      const firstDir = state.path("custom-first");
      const secondDir = state.path("custom-second");
      const replacementDir = state.path("custom-replacement");
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            first: { agentDir: firstDir },
            second: { agentDir: secondDir },
          },
        },
      };
      setRuntimeAuthProfileStoreSnapshot(storedChoice(true), firstDir);
      setRuntimeAuthProfileStoreSnapshot(storedChoice(false), secondDir);
      setRuntimeAuthProfileStoreSnapshot(storedChoice(false), replacementDir);
      const first = decisionOwner(cfg, "first", state.workspaceDir);
      const second = decisionOwner(cfg, "second", state.workspaceDir);
      expect(await readRow(first, "same-row")).toMatchObject({
        availability: true,
        evidence: "runtime",
      });
      expect((await readRow(second, "same-row")).evidence).not.toBe("runtime");
      const replacement = decisionOwner(
        {
          ...cfg,
          agents: {
            ...cfg.agents,
            entries: { ...cfg.agents?.entries, first: { agentDir: replacementDir } },
          },
        },
        "first",
        state.workspaceDir,
      );
      expect((await readRow(replacement, "same-row")).evidence).not.toBe("runtime");
      expect(await readRow(first, "old-owner-new-row")).toMatchObject({
        availability: true,
        evidence: "runtime",
      });
    });
  });
});
