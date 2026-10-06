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
import { createPreparedAccountCatalogAccess } from "./prepared-model-runtime.catalog-auth.js";

const entry: ModelCatalogEntry = { provider: "openai", id: "gpt-5.4", name: "GPT" };
const config: OpenClawConfig = {
  plugins: { entries: { codex: { enabled: true } } },
  agents: { defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } } } },
};
const metadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
});
function harnessRegistry(id: string) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: id,
    source: "fixture",
    harness: {
      id,
      label: id,
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("Catalog reads must not execute a model");
      },
    },
  });
  return registry;
}

function nativeOwner(complete: boolean, loggedIn: boolean, isCurrent = () => true, cfg = config) {
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
    pluginRegistry: harnessRegistry("codex"),
    isCurrent,
    routeResolverFactory: routeResolverFactory(dualRoutes),
  });
}

describe("captured model decisions", () => {
  beforeEach(() => {
    // These cases describe prepared auth facts, not credentials from the host shell.
    for (const key of [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_OAUTH_TOKEN",
      "CHATGPT_OAUTH_TOKEN",
    ]) {
      vi.stubEnv(key, "");
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it("retains account discovery across request projections until explicit refresh or identity replacement", async () => {
    const retirement = new AbortController();
    const owner = createPreparedAccountCatalogAccess(() => true, retirement.signal);
    const credential = {
      type: "token",
      provider: "openai",
      token: "synthetic-account-token",
    } as const;
    const load = vi.fn(async () => [
      { provider: "openai", profileId: "account", status: "ready" as const },
    ]);
    const request = { profileId: "account", credential, load, allowDiscovery: true };
    expect((await owner.acquire({ ...request, allowDiscovery: false })).outcomes).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    const first = await owner.acquire(request);
    await owner.acquire({ ...request, credential: { ...credential } });
    await owner.acquire({ ...request, allowDiscovery: false });
    expect(load).toHaveBeenCalledOnce();
    const refreshed = await owner.acquire({ ...request, refresh: true });
    expect(load).toHaveBeenCalledTimes(2);
    expect(first.isCurrent()).toBe(false);
    await owner.acquire({
      ...request,
      credential: { ...credential, token: "synthetic-replacement-token" },
    });
    expect(refreshed.isCurrent()).toBe(false);
    expect(load).toHaveBeenCalledTimes(3);
    retirement.abort();
    await expect(owner.acquire(request)).rejects.toThrow("changed");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps response tiers account-bound without completing discovery and revokes stale observers", async () => {
    const retirement = new AbortController();
    const owner = createPreparedAccountCatalogAccess(() => true, retirement.signal);
    const credential = { type: "api_key", provider: "openai", key: "synthetic-key" } as const;
    const account = {
      profileId: "openai:account",
      credential,
      selectedCredential: {
        source: "profile" as const,
        profileId: "openai:account",
        identityKey: "profile:openai:account",
      },
    };
    const observation = {
      modelId: "fixture-model",
      runtimeId: "openclaw",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1/",
      serviceTiers: ["priority"],
    };
    const route = { ...observation, identityKey: account.selectedCredential.identityKey };
    const record = owner.prepareServiceTierObserver(account);
    expect(record(observation)).toBe(true);
    expect(record({ ...observation, baseUrl: "https://api.openai.com/v1" })).toBe(false);
    expect(owner.readServiceTiers(route)).toEqual(["priority"]);
    for (const mismatch of [
      { identityKey: "profile:openai:other" },
      { modelId: "other-model" },
      { runtimeId: "codex" },
      { api: "openai-chatgpt-responses" },
      { baseUrl: "https://other.example/v1" },
    ]) {
      expect(owner.readServiceTiers({ ...route, ...mismatch })).toBeUndefined();
    }
    const outcomes = [
      { provider: "openai", profileId: account.profileId, status: "ready" as const },
    ];
    const load = vi.fn(async () => outcomes);
    const request = { ...account, load, allowDiscovery: true };
    expect((await owner.acquire({ ...request, allowDiscovery: false })).outcomes).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    const catalogFailure = new Error("catalog unavailable");
    await expect(
      owner.acquire({
        ...request,
        load: async () => {
          throw catalogFailure;
        },
      }),
    ).rejects.toBe(catalogFailure);
    expect(owner.readServiceTiers(route)).toEqual(["priority"]);
    expect((await owner.acquire(request)).outcomes).toEqual(outcomes);
    expect(owner.readServiceTiers(route)).toEqual(["priority"]);
    expect(load).toHaveBeenCalledOnce();

    await owner.acquire({ ...request, refresh: true });
    expect(owner.readServiceTiers(route)).toBeUndefined();
    expect(record(observation)).toBe(false);
    const refreshed = owner.prepareServiceTierObserver(account);
    expect(refreshed(observation)).toBe(true);
    const replaced = owner.prepareServiceTierObserver({
      ...account,
      credential: { ...credential, key: "synthetic-replacement-key" },
    });
    expect(owner.readServiceTiers(route)).toBeUndefined();
    expect(refreshed(observation)).toBe(false);
    expect(replaced(observation)).toBe(true);
    retirement.abort();
    expect(owner.readServiceTiers(route)).toBeUndefined();
    expect(replaced(observation)).toBe(false);
    expect(owner.prepareServiceTierObserver(account)(observation)).toBe(false);
  });

  it("bounds response tier observations per account and rejects a superseded owner", () => {
    let current = true;
    const owner = createPreparedAccountCatalogAccess(() => current);
    const account = {
      profileId: "openai:account",
      selectedCredential: {
        source: "profile" as const,
        profileId: "openai:account",
        identityKey: "profile:openai:account",
      },
      credential: { type: "api_key", provider: "openai", key: "synthetic-key" } as const,
    };
    const route = {
      identityKey: account.selectedCredential.identityKey,
      modelId: "model-0",
      runtimeId: "openclaw",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const record = owner.prepareServiceTierObserver(account);
    for (let index = 0; index <= 128; index++) {
      record({ ...route, modelId: `model-${index}`, serviceTiers: ["priority"] });
    }
    expect(owner.readServiceTiers(route)).toBeUndefined();
    expect(owner.readServiceTiers({ ...route, modelId: "model-128" })).toEqual(["priority"]);
    current = false;
    expect(owner.readServiceTiers({ ...route, modelId: "model-128" })).toBeUndefined();
    expect(record({ ...route, serviceTiers: ["priority"] })).toBe(false);
  });

  it("prepares only the selected account through the existing catalog hook", async () => {
    const pluginRegistry = harnessRegistry("codex");
    const catalog = vi.fn(
      async (ctx: import("../plugins/provider-catalog.types.js").ProviderCatalogContext) => {
        const auth = ctx.resolveProviderAuth("openai");
        expect(auth.profileId).toBe("openai:selected");
        return {
          provider: { baseUrl: subscriptionRoute.baseUrl, models: [] },
          outcomes: [
            {
              provider: "openai",
              profileId: auth.profileId,
              status: "ready" as const,
              modelServiceTiers: [
                {
                  modelId: entry.id,
                  runtimeId: "codex",
                  api: subscriptionRoute.api,
                  baseUrl: subscriptionRoute.baseUrl,
                  serviceTiers: ["ultrafast"],
                },
              ],
            },
          ],
        };
      },
    );
    pluginRegistry.providers.push({
      pluginId: "openai",
      source: "fixture",
      provider: { id: "openai", label: "OpenAI", auth: [], catalog: { run: catalog } },
    });
    const sharedSnapshot = { entries: [entry], routeVariants: [entry] };
    const prepared = createModelCatalogDecisions({
      cfg: config,
      agentId: "main",
      agentDir: "/tmp/selected-tier-agent",
      workspaceDir: "/tmp/selected-tier-workspace",
      snapshot: sharedSnapshot,
      accountCatalog: createPreparedAccountCatalogAccess(() => true),
      metadataSnapshot: metadata,
      pluginRegistry,
      preparedAuthStore: {
        version: 1,
        profiles: {
          "openai:shared": { provider: "openai", type: "token", token: "synthetic-shared-token" },
          "openai:selected": {
            provider: "openai",
            type: "token",
            token: "synthetic-selected-token",
          },
        },
      },
      preferredProfileId: "openai:selected",
      pinnedProfileId: "openai:selected",
      routeResolverFactory: routeResolverFactory(dualRoutes),
      isCurrent: () => true,
    });
    const assertCurrent = vi.fn();
    await prepared.prepareSelectedAccountCatalog(assertCurrent, { allowDiscovery: true });
    await prepared.prepareSelectedAccountCatalog(assertCurrent, { allowDiscovery: true });
    expect(catalog).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalled();
    expect(sharedSnapshot).not.toHaveProperty("providerOutcomes");
    expect(prepared.snapshot.providerOutcomes?.[0]?.modelServiceTiers?.[0]?.serviceTiers).toEqual([
      "ultrafast",
    ]);
    expect(await prepared.evaluateEntry(entry, undefined, "codex")).toMatchObject({
      selectedProfileId: "openai:selected",
      availability: true,
    });
  });

  it("does not publish a selected-account result after its generation expires", async () => {
    let current = true;
    const pluginRegistry = harnessRegistry("codex");
    pluginRegistry.providers.push({
      pluginId: "openai",
      source: "fixture",
      provider: {
        id: "openai",
        label: "OpenAI",
        auth: [],
        catalog: {
          run: async (ctx) => {
            current = false;
            return {
              provider: { baseUrl: subscriptionRoute.baseUrl, models: [] },
              outcomes: [
                {
                  provider: "openai",
                  profileId: ctx.resolveProviderAuth("openai").profileId,
                  status: "ready",
                },
              ],
            };
          },
        },
      },
    });
    const prepared = createModelCatalogDecisions({
      cfg: config,
      agentId: "main",
      snapshot: { entries: [entry], routeVariants: [entry] },
      metadataSnapshot: metadata,
      pluginRegistry,
      preparedAuthStore: {
        version: 1,
        profiles: {
          "openai:selected": {
            provider: "openai",
            type: "token",
            token: "synthetic-selected-token",
          },
        },
      },
      preferredProfileId: "openai:selected",
      accountCatalog: createPreparedAccountCatalogAccess(() => current),
      isCurrent: () => current,
    });
    await expect(
      prepared.prepareSelectedAccountCatalog(() => {}, { allowDiscovery: true }),
    ).rejects.toThrow("changed");
    expect(prepared.snapshot.providerOutcomes).toEqual([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])(
    "preserves provider auth for a non-CLI harness (authenticated=%s)",
    async (authenticated) => {
      const model = { provider: "github-copilot", id: "fixture-model", name: "Fixture model" };
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
        pluginRegistry: harnessRegistry("copilot"),
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
