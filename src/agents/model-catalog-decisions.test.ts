import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPluginCatalog } from "../plugins/provider-catalog.types.js";
import { createEmptyPluginSetupRegistry } from "../plugins/setup-registry.test-support.js";
import { connectUserModelAccount } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { noteCommittedSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./auth-profiles/runtime-snapshots.js";
import * as personalCatalogReads from "./auth-profiles/sqlite-read.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  createClaudeCliBackends,
  testing as cliBackendsTesting,
} from "./cli-backends.test-support.js";
import {
  dualRoutes,
  platformRoute,
  routeResolverFactory,
  mockRouteResolverFactory,
  subscriptionRoute,
} from "./model-auth-availability.test-support.js";
import { projectClaudeCliNativeCatalog } from "./model-catalog-cli-wildcard.js";
import {
  createModelCatalogDecisions,
  prepareModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
} from "./model-catalog-decisions.js";
import {
  apiKey,
  authStore,
  harnessRegistry,
  oauth,
  row as model,
  runtimeConfig,
  snapshot as catalogSnapshot,
  token,
} from "./model-catalog-fixtures.test-support.js";
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
type DecisionParams = Parameters<typeof createModelCatalogDecisions>[0];
const emptyAuth = authStore();
const tokenStore = (...ids: string[]) =>
  authStore(Object.fromEntries(ids.map((id) => [id, token(`synthetic-${id}`)])));
function decisions(overrides: Partial<DecisionParams>) {
  return createModelCatalogDecisions({
    cfg: {},
    agentId: "main",
    workspaceDir: "/tmp/catalog-workspace",
    snapshot: catalogSnapshot([entry]),
    metadataSnapshot: metadata,
    preparedAuthStore: emptyAuth,
    ...overrides,
  });
}
function catalogRegistry(run: ProviderPluginCatalog["run"]) {
  const registry = harnessRegistry("codex");
  registry.providers.push({
    pluginId: "openai",
    source: "fixture",
    provider: { id: "openai", label: "OpenAI", auth: [], catalog: { run } },
  });
  return registry;
}

const runtimeAvailable = { availability: true, evidence: "runtime" };

function nativeOwner(complete: boolean, loggedIn: boolean, cfg = config) {
  mockRouteResolverFactory(routeResolverFactory(dualRoutes));
  return decisions({
    cfg,
    agentDir: "/tmp/catalog-agent",
    preparedRuntimeAuthModes: loggedIn ? { codex: { source: "native", mode: "api_key" } } : {},
    preparedSyntheticAuthComplete: complete,
    pluginRegistry: harnessRegistry("codex"),
  });
}

describe("captured model decisions", () => {
  it("does not start private reads after retained authority revokes during reader preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const owner = ensureProfileForEmail("catalog-authority@example.test");
      const { authProfileId } = connectUserModelAccount({
        ownerProfileId: owner.id,
        credential: { type: "api_key", provider: "openai", key: "synthetic-private-key" },
        assertCurrent() {},
      });
      using read = vi
        .spyOn(personalCatalogReads, "readPersonalCatalogProfiles")
        .mockRejectedValue(new Error("Private catalog read must not start"));
      const revoked = new Error("Catalog read authority revoked");
      let current = true;
      const pending = prepareModelCatalogDecisions(
        {
          cfg: {},
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          snapshot: catalogSnapshot([entry]),
          metadataSnapshot: metadata,
          preparedAuthStore: emptyAuth,
          preferredProfileId: authProfileId,
        },
        {
          async withCurrent<T>(consume: () => T): Promise<Awaited<T>> {
            if (!current) {
              throw revoked;
            }
            return await consume();
          },
        },
      );
      current = false;
      await expect(pending).rejects.toBe(revoked);
      expect(read).not.toHaveBeenCalled();
    });
  });

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

  const accountSelections = ["session", "configured", "automatic"];
  it.each(accountSelections)("prepares %s account discovery", async (selection) => {
    const catalog = vi.fn<ProviderPluginCatalog["run"]>(async (ctx) => {
      const auth = ctx.resolveProviderAuth("openai");
      expect(["openai:selected", ...(selection === "automatic" ? ["openai:auto"] : [])]).toContain(
        auth.profileId,
      );
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
    });
    const pluginRegistry = catalogRegistry(catalog);
    const sharedSnapshot = catalogSnapshot([entry]);
    const cfg: OpenClawConfig = {
      ...config,
      agents: {
        defaults: {
          ...config.agents?.defaults,
          model: {
            primary: `openai/${entry.id}@openai:${selection === "session" ? "shared" : "selected"}`,
          },
        },
      },
    };
    mockRouteResolverFactory(routeResolverFactory(dualRoutes));
    const prepared = decisions({
      cfg,
      agentDir: "/tmp/selected-tier-agent",
      workspaceDir: "/tmp/selected-tier-workspace",
      snapshot: sharedSnapshot,
      accountCatalog: createPreparedAccountCatalogAccess(() => true),
      pluginRegistry,
      preparedAuthStore: tokenStore("openai:shared", "openai:auto", "openai:selected"),
      preferredProfileId:
        selection === "automatic"
          ? "openai:auto"
          : selection === "session"
            ? "openai:selected"
            : undefined,
      pinnedProfileId: selection === "session" ? "openai:selected" : undefined,
      isCurrent: () => true,
    });
    const assertCurrent = vi.fn();
    await prepared.prepareSelectedAccountCatalog(assertCurrent, { refresh: true });
    await prepared.prepareSelectedAccountCatalog(assertCurrent, {});
    expect(catalog).toHaveBeenCalledTimes(selection === "automatic" ? 2 : 1);
    expect(assertCurrent).toHaveBeenCalled();
    expect(sharedSnapshot).not.toHaveProperty("providerOutcomes");
    expect(prepared.snapshot.providerOutcomes?.[0]?.modelServiceTiers?.[0]?.serviceTiers).toEqual([
      "ultrafast",
    ]);
    expect(prepared.evaluateEntry(entry, undefined, "codex")).toMatchObject({
      selectedProfileId: "openai:selected",
      availability: true,
    });
  });

  it("does not publish a selected-account result after its generation expires", async () => {
    let current = true;
    const pluginRegistry = catalogRegistry(async (ctx) => {
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
    });
    const prepared = decisions({
      cfg: config,
      workspaceDir: undefined,
      pluginRegistry,
      preparedAuthStore: tokenStore("openai:selected"),
      preferredProfileId: "openai:selected",
      accountCatalog: createPreparedAccountCatalogAccess(() => current),
      isCurrent: () => current,
    });
    await expect(
      prepared.prepareSelectedAccountCatalog(() => {}, { refresh: true }),
    ).rejects.toThrow("changed");
    expect(prepared.snapshot.providerOutcomes).toEqual([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("preserves provider auth for an authenticated non-CLI harness", async () => {
    const copilotEntry = model("github-copilot", "fixture-model");
    const owner = decisions({
      cfg: { plugins: { entries: { copilot: { enabled: true } } } },
      agentDir: "/tmp/copilot-agent",
      workspaceDir: "/tmp/copilot-workspace",
      snapshot: catalogSnapshot([copilotEntry]),
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [{ id: "github-copilot", providers: ["github-copilot"] }, { id: "copilot" }],
      }),
      preparedAuthStore: authStore({
        "github-copilot:work": {
          type: "token",
          provider: "github-copilot",
          token: "fixture-token",
        },
      }),
      preparedSyntheticAuthComplete: true,
      pluginRegistry: harnessRegistry("copilot"),
      isCurrent: () => true,
    });
    const choices = owner.runtimeChoices(copilotEntry);
    expect(owner.evaluateEntry(copilotEntry, undefined, "copilot")).toMatchObject({
      availability: true,
      selectedProfileId: "github-copilot:work",
    });
    expect(choices).toContain("copilot");
  });

  it("keeps native availability and runtime together under auto policy", async () => {
    vi.spyOn(openaiRoutes, "resolveOpenAIModelRoutes").mockImplementation(({ api }) => ({
      ...dualRoutes,
      defaultRuntimeId: api ? "openclaw" : "codex",
    }));
    const cfg: OpenClawConfig = {
      plugins: config.plugins,
      ...runtimeConfig({ "openai/gpt-5.4": "auto" }),
    };
    const owner = nativeOwner(true, true, cfg);
    const evaluation = owner.evaluateEntry(entry);
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
    const owner = nativeOwner(true, false, cfg);
    const evaluation = owner.evaluateEntry(entry);
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
    mockRouteResolverFactory(() => (ref) => ({
      ...dualRoutes,
      routes: ref.observedRoutes?.some((route) => route.api === subscriptionRoute.api)
        ? [subscriptionRoute]
        : [platformRoute],
    }));
    const owner = decisions({
      snapshot: catalogSnapshot([]),
      preparedAuthStore: authStore({
        "openai:platform": apiKey("openai"),
      }),
    });
    expect(
      owner.evaluateEntry({ provider: entry.provider, id: entry.id }, undefined, "openclaw"),
    ).toMatchObject({ availability: true, selectedProfileId: "openai:platform" });
    expect(
      owner.evaluateEntry(
        { ...entry, api: subscriptionRoute.api, baseUrl: subscriptionRoute.baseUrl },
        undefined,
        "openclaw",
      ),
    ).toMatchObject({ availability: false });
  });

  describe("with a ChatGPT account listing", () => {
    const chatgpt = oauth("openai", Date.now() + 60 * 60_000);
    const platformKey = apiKey("openai");
    type Outcome =
      | { profileId: string; status: "ready"; listedModelIds: readonly string[] }
      | { profileId: string; status: "unavailable" };
    const listing = (profileId: string, ...listedModelIds: string[]): Outcome => ({
      profileId,
      status: "ready",
      listedModelIds,
    });
    const evaluate = (
      outcomes: readonly Outcome[],
      id: string,
      options: { profileIds?: readonly string[]; withApiKey?: boolean; pin?: string } = {},
    ) => {
      mockRouteResolverFactory(
        routeResolverFactory({
          ...dualRoutes,
          preferredAuthRequirement: "subscription",
        }),
      );
      return decisions({
        pinnedProfileId: options.pin,
        snapshot: catalogSnapshot([], {
          providerOutcomes: outcomes.map((outcome) => ({ provider: "openai", ...outcome })),
        }),
        preparedAuthStore: authStore({
          ...Object.fromEntries(
            (options.profileIds ?? ["openai:chatgpt"]).map((profileId) => [profileId, chatgpt]),
          ),
          ...(options.withApiKey ? { "openai:platform": platformKey } : {}),
        }),
      }).evaluateEntry({ provider: "openai", id }, undefined, "codex");
    };
    // The listing returned gpt-5.5 as a hidden row and did not return gpt-5.4-pro.
    const ready = listing("openai:chatgpt", "gpt-6-sol", "gpt-5.5");

    it("does not offer an unlisted dual-route model to a ChatGPT-only account", () => {
      const unlisted = evaluate([ready], "gpt-5.4-pro");
      expect(unlisted).toMatchObject({ availability: false });
      // The account is signed in; a missing-auth reason would render sign-in guidance.
      expect(unlisted.unavailableReason).toBeUndefined();
      expect(evaluate([ready], "gpt-5.5")).toMatchObject({
        availability: true,
        selectedProfileId: "openai:chatgpt",
      });
    });

    it.each([
      ["an OpenAI API key is also stored", ready, true],
      [
        "the listing is unavailable",
        { profileId: "openai:chatgpt", status: "unavailable" } as const,
        false,
      ],
    ])("keeps the subscription route when %s", (_label, outcome, withApiKey) => {
      expect(evaluate([outcome], "gpt-5.4-pro", { withApiKey })).toMatchObject({
        availability: true,
        selectedProfileId: "openai:chatgpt",
        selectedRoute: { authRequirement: "subscription" },
      });
    });

    const selectedB = {
      availability: true,
      selectedProfileId: "openai:b",
      selectedRoute: { authRequirement: "subscription" },
    };
    it.each([
      ["it has no observation", [], selectedB],
      ["its listing returns the model", [listing("openai:b", "gpt-5.5-pro")], selectedB],
      // A third account listing the model does not entitle the selected one.
      [
        "its listing omits the model",
        [listing("openai:b", "gpt-5.5"), listing("openai:c", "gpt-5.5-pro")],
        { availability: false },
      ],
    ])("uses only the selected account's listing when %s", (_label, outcomes, expected) => {
      // Account A's ready listing omits gpt-5.5-pro and gpt-5.5; account B is selected.
      const others = [listing("openai:a", "gpt-6-sol")];
      const options = { profileIds: ["openai:a", "openai:b"], pin: "openai:b" };
      expect(evaluate([...others, ...outcomes], "gpt-5.5-pro", options)).toMatchObject(expected);
    });
  });

  it("distinguishes unknown choices from authoritative empty choices", async () => {
    expect(nativeOwner(false, false).runtimeChoices(entry)).toBeUndefined();
    expect(nativeOwner(true, false).runtimeChoices(entry)).toEqual([]);
  });

  it("keeps a different provider's account pin out of the selected route", async () => {
    mockRouteResolverFactory(routeResolverFactory({ ...dualRoutes, routes: [platformRoute] }));
    const owner = decisions({
      preferredProfileId: "anthropic:chosen",
      pinnedProfileId: "anthropic:chosen",
      profileProvider: "anthropic",
      preparedAuthStore: authStore({
        "anthropic:chosen": apiKey("anthropic"),
        "openai:chosen": apiKey("openai"),
      }),
    });
    expect(owner.evaluateEntry(entry, [entry], "openclaw")).toMatchObject({
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
      resolvePluginSetupRegistry: () => createEmptyPluginSetupRegistry(),
      resolveRuntimeCliBackends: createClaudeCliBackends,
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
    return authStore(
      { selected: cli ? oauth("claude-cli", Date.now() + 600_000) : apiKey("anthropic") },
      { order: { anthropic: ["selected"] } },
    );
  }

  function decisionOwner(cfg: OpenClawConfig, agentId: string, workspaceDir: string) {
    return decisions({
      cfg,
      agentId,
      workspaceDir,
      snapshot: catalogSnapshot([]),
      metadataSnapshot: cliMetadata,
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
          direct: apiKey("anthropic"),
        },
      };
      setRuntimeAuthProfileStoreSnapshot(orderStore, state.path("custom-worker"));
      const owner = decisionOwner(cfg, "worker", state.workspaceDir);
      expect(readRow(owner, "before-order-change")).toMatchObject({
        ...runtimeAvailable,
        selectedAuthMode: "oauth",
      });

      setRuntimeAuthProfileStoreSnapshot(
        { ...orderStore, order: { anthropic: ["direct"] } },
        state.path("custom-worker"),
      );
      // New keys bypass the intentional completed-row decision memoization.
      expect(readRow(owner, "after-order-change").evidence).not.toBe("runtime");
      setRuntimeAuthProfileStoreSnapshot(orderStore, state.path("custom-worker"));
      expect(readRow(owner, "after-order-restored")).toMatchObject(runtimeAvailable);
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
      expect(readRow(owner, "before-relocation").evidence).not.toBe("runtime");

      noteCommittedSharedAuthStoreOwnership({ location: "state-db" });
      setRuntimeAuthProfileStoreSnapshot(storedChoice(true));
      expect(readRow(owner, "after-relocation")).toMatchObject({
        ...runtimeAvailable,
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
      expect(readRow(first, "same-row")).toMatchObject(runtimeAvailable);
      expect(readRow(second, "same-row").evidence).not.toBe("runtime");
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
      expect(readRow(replacement, "same-row").evidence).not.toBe("runtime");
      expect(readRow(first, "old-owner-new-row")).toMatchObject(runtimeAvailable);
    });
  });

  it("keeps CLI menu restricted to listed and explicitly configured models", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          ...createClaudeCliBackends(),
          {
            id: "google-gemini-cli",
            modelProvider: "google",
            pluginId: "google",
            config: { command: "gemini" },
          },
        ],
      });
      const menu = (pinned: boolean) =>
        createModelCatalogDecisions({
          cfg: runtimeConfig({
            "anthropic/*": "claude-cli",
            "anthropic/claude-pinned": "claude-cli",
            "anthropic/claude-http": "openclaw",
            "anthropic/claude-typed": undefined,
            "google/*": "google-gemini-cli",
          }),
          agentId: "main",
          workspaceDir: state.workspaceDir,
          snapshot: catalogSnapshot(
            [model("claude-cli", "claude-stale"), model("google-gemini-cli", "gemini-listed")],
            {
              routeVariants: [],
              providerOutcomes: [
                {
                  provider: "claude-cli",
                  status: "ready",
                  listedModelIds: ["claude-listed"],
                },
              ],
            },
          ),
          metadataSnapshot: cliMetadata,
          preparedAuthStore: pinned
            ? authStore({ "anthropic:work": apiKey("anthropic") })
            : emptyAuth,
          preparedRuntimeAuthModes: { "claude-cli": "oauth", "google-gemini-cli": "oauth" },
          preparedSyntheticAuthComplete: true,
          ...(pinned
            ? { preferredProfileId: "anthropic:work", pinnedProfileId: "anthropic:work" }
            : {}),
        });
      const owner = menu(false);
      const availability = (provider: string, id: string) =>
        owner.evaluateEntry({ provider, id }).availability;

      expect(availability("anthropic", "claude-listed")).toBe(true);
      expect(availability("anthropic", "claude-stale")).toBe(false);
      // API-only rows stay out of a Claude CLI picker without a sign-in prompt.
      const apiOnly = owner.evaluateEntry({ provider: "anthropic", id: "claude-mythos-5" });
      expect(apiOnly.availability).toBe(false);
      expect(apiOnly.unavailableReason).toBeUndefined();
      expect(availability("anthropic", "claude-pinned")).toBe(true);
      expect(availability("anthropic", "claude-typed")).toBe(true);
      // An exact override to another runtime stays with ordinary provider auth, not Claude CLI.
      expect(owner.evaluateEntry({ provider: "anthropic", id: "claude-http" }).evidence).not.toBe(
        "runtime",
      );
      // User-authored wildcards to other CLI backends are unchanged.
      expect(availability("google", "gemini-unlisted")).toBe(true);
      // A pinned API-key account, not the Claude CLI login, answers for its own models.
      const account = menu(true);
      const mythos = { provider: "anthropic", id: "claude-mythos-5" };
      const host = account.evaluateEntry(mythos);
      expect(host).toMatchObject({ availability: true, selectedProfileId: "anthropic:work" });
      expect(
        account.evaluateNative({ ...mythos, name: "Claude Mythos 5" }, host).availability,
      ).toBe(true);
      expect(
        owner.evaluateNative({ ...mythos, name: "Claude Mythos 5" }, apiOnly).availability,
      ).toBe(false);
    });
  });
});

it("projects exact native IDs and effort levels without expanding a restricted menu", () => {
  const native = model("claude-cli", "claude-future", {
    name: "Future",
    reasoning: true,
    thinkingLevelMap: { low: "low", max: "max" },
  });
  const donor = model("anthropic", "claude-future", {
    name: "Hosted metadata",
    contextWindow: 456_000,
    thinkingLevelMap: { high: "high" },
  });
  const hostedOnly = model("anthropic", "claude-hosted-only");
  const snapshot = {
    entries: [native, donor, hostedOnly, model("claude-cli", "claude-stale")],
    routeVariants: [],
    staticEntries: [donor, hostedOnly],
    providerOutcomes: [
      {
        provider: "claude-cli",
        status: "ready" as const,
        listedModelIds: [native.id],
      },
    ],
  };
  const projected = projectClaudeCliNativeCatalog(snapshot, true);
  expect(projected).toMatchObject({
    entries: [
      {
        provider: "anthropic",
        id: native.id,
        contextWindow: 456_000,
        thinkingLevelMap: native.thinkingLevelMap,
      },
    ],
    staticEntries: [],
  });
  expect(projectClaudeCliNativeCatalog(snapshot, false).entries).toContain(donor);
  expect(
    projectClaudeCliNativeCatalog({ ...snapshot, providerOutcomes: [] }, true).entries,
  ).toEqual([donor, hostedOnly]);
});
