import { performance } from "node:perf_hooks";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createChatMetadataOwner } from "../gateway/server-methods/chat-metadata-runtime.test-support.js";
import { prepareChatMetadataModelProjection } from "../gateway/server-methods/chat-metadata-session-projection.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "../gateway/test-helpers.env.js";
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
import * as autoSelection from "./harness/auto-selection.js";
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
import { PreparedModelRuntimePublicationSupersededError as SupersededError } from "./prepared-model-runtime.errors.js";

const entry: ModelCatalogEntry = { provider: "openai", id: "gpt-5.4", name: "GPT" };
const config: OpenClawConfig = {
  plugins: { entries: { codex: { enabled: true } } },
  agents: { defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } } } },
};
const metadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
});
type DecisionParams = Parameters<typeof createModelCatalogDecisions>[0];
type Evaluation = ReturnType<ReturnType<typeof createModelCatalogDecisions>["evaluateEntry"]>;
function expectAvailable(evaluation: Evaluation, selectedProfileId: string) {
  expect(evaluation).toMatchObject({ availability: true, selectedProfileId });
}
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
  it("stops private reads when retained authority revokes during preparation", async () => {
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

  const keys = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_OAUTH_TOKEN", "CHATGPT_OAUTH_TOKEN"];
  beforeEach(() => {
    // These cases describe prepared auth facts, not credentials from the host shell.
    for (const key of keys) {
      vi.stubEnv(key, "");
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  const accountSelections = ["session", "configured", "automatic"] as const;
  it.each(accountSelections)("prepares %s account discovery", async (selection) => {
    const catalog = vi.fn<ProviderPluginCatalog["run"]>(async (ctx) => {
      const auth = ctx.resolveProviderAuth("openai");
      const profiles = ["openai:selected", ...(selection === "automatic" ? ["openai:auto"] : [])];
      expect(profiles).toContain(auth.profileId);
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
    const sharedSnapshot = catalogSnapshot([entry]);
    const profile = selection === "session" ? "shared" : "selected";
    const modelRef = { primary: `openai/${entry.id}@openai:${profile}` };
    const defaults = { ...config.agents?.defaults, model: modelRef };
    const cfg: OpenClawConfig = { ...config, agents: { defaults } };
    mockRouteResolverFactory(routeResolverFactory(dualRoutes));
    const prepared = decisions({
      cfg,
      agentDir: "/tmp/selected-tier-agent",
      workspaceDir: "/tmp/selected-tier-workspace",
      snapshot: sharedSnapshot,
      accountCatalog: createPreparedAccountCatalogAccess(() => true),
      pluginRegistry: catalogRegistry(catalog),
      preparedAuthStore: tokenStore("openai:shared", "openai:auto", "openai:selected"),
      preferredProfileId: {
        automatic: "openai:auto",
        configured: undefined,
        session: "openai:selected",
      }[selection],
      pinnedProfileId: selection === "session" ? "openai:selected" : undefined,
      isCurrent: () => true,
    });
    const assertCurrent = vi.fn();
    await prepared.prepareSelectedAccountCatalog(assertCurrent, { refresh: true });
    await prepared.prepareSelectedAccountCatalog(assertCurrent, {});
    expect(catalog).toHaveBeenCalledTimes(selection === "automatic" ? 2 : 1);
    expect(assertCurrent).toHaveBeenCalled();
    expect(sharedSnapshot).not.toHaveProperty("providerOutcomes");
    const tiers = prepared.snapshot.providerOutcomes?.[0]?.modelServiceTiers;
    expect(tiers?.[0]?.serviceTiers).toEqual(["ultrafast"]);
    expectAvailable(prepared.evaluateEntry(entry, undefined, "codex"), "openai:selected");
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

  it("offers an authenticated non-CLI harness with the configured host runtime", async () => {
    const copilotEntry = model("github-copilot", "fixture-model");
    const owner = decisions({
      cfg: {
        plugins: { entries: { copilot: { enabled: true } } },
        agents: {
          defaults: {
            models: { "github-copilot/fixture-model": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
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
    const evaluation = owner.evaluateEntry(copilotEntry, undefined, "copilot");
    expectAvailable(evaluation, "github-copilot:work");
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
    const openai = {
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "synthetic-host-key",
      models: [],
    };
    const cfg: OpenClawConfig = { models: { providers: { openai } } };
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
    expectAvailable(
      owner.evaluateEntry({ provider: entry.provider, id: entry.id }, undefined, "openclaw"),
      "openai:platform",
    );
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
    const accountDecisions = (
      outcomes: readonly Outcome[],
      options: {
        profileIds?: readonly string[];
        withApiKey?: boolean;
        pin?: string;
        accountCatalog?: DecisionParams["accountCatalog"];
        entries?: ModelCatalogEntry[];
      } = {},
    ) => {
      mockRouteResolverFactory(
        routeResolverFactory({ ...dualRoutes, preferredAuthRequirement: "subscription" }),
      );
      return decisions({
        pinnedProfileId: options.pin,
        accountCatalog: options.accountCatalog,
        snapshot: catalogSnapshot(options.entries, {
          providerOutcomes: outcomes.map((outcome) => ({ provider: "openai", ...outcome })),
        }),
        preparedAuthStore: authStore({
          ...Object.fromEntries(
            (options.profileIds ?? ["openai:chatgpt"]).map((profileId) => [profileId, chatgpt]),
          ),
          ...(options.withApiKey ? { "openai:platform": platformKey } : {}),
        }),
      });
    };
    const evaluate = (
      outcomes: readonly Outcome[],
      id: string,
      options?: Parameters<typeof accountDecisions>[1],
    ) => {
      const owner = accountDecisions(outcomes, options);
      return owner.evaluateEntry({ provider: "openai", id }, undefined, "codex");
    };
    // The listing returned gpt-5.5 as a hidden row and did not return gpt-5.4-pro.
    const ready = listing("openai:chatgpt", "gpt-6-sol", "gpt-5.5");

    it("indexes a ready account listing once across distinct models and decision owners", () => {
      const ids = Array.from({ length: 64 }, (_, index) => `fixture-${index}`);
      const listedModelIds = ids.map((id) => id.toUpperCase());
      // Each complete listing traversal reads its first ID, regardless of the iteration method.
      const firstId = vi.fn(() => " FIXTURE-0 ");
      Object.defineProperty(listedModelIds, 0, { get: firstId });
      for (const profileId of ["openai:work", "openai:personal"]) {
        const owner = accountDecisions([{ profileId, status: "ready", listedModelIds }], {
          profileIds: [profileId],
          pin: profileId,
        });
        for (const id of ids) {
          expectAvailable(
            owner.evaluateEntry({ provider: "openai", id }, undefined, "codex"),
            profileId,
          );
        }
      }
      expect(firstId).toHaveBeenCalledTimes(1);
    });

    it("replaces cached model decisions when the selected account publishes an empty listing", async () => {
      const provider = "openai";
      const profileId = "openai:chatgpt";
      const accountCatalog = createPreparedAccountCatalogAccess(() => true);
      await accountCatalog.acquire({
        profileId,
        credential: chatgpt,
        allowDiscovery: true,
        load: async () => [{ provider, profileId, status: "ready", listedModelIds: [] }],
      });
      const row = model(provider, "gpt-5.5");
      const sibling = model("other", "fixture");
      const options = { pin: profileId, entries: [row, sibling], accountCatalog };
      const owner = accountDecisions([ready], options);
      const evaluateRow = (catalogRow: ModelCatalogEntry) =>
        owner.evaluateEntry(catalogRow, undefined, "codex");
      expectAvailable(evaluateRow(row), profileId);
      const siblingDecision = evaluateRow(sibling);
      const initial = await owner.projectCatalog();
      await owner.prepareSelectedAccountCatalog(() => {}, {});
      expect(owner.isCurrent()).toBe(true);
      expect(evaluateRow(row).availability).toBe(false);
      expect(evaluateRow(sibling)).toBe(siblingDecision);
      const updated = await owner.projectCatalog();
      expect(updated).not.toBe(initial);
      await owner.prepareSelectedAccountCatalog(() => {}, {});
      expect(await owner.projectCatalog()).toBe(updated);
    });

    it("does not offer an unlisted dual-route model to a ChatGPT-only account", () => {
      const unlisted = evaluate([ready], "gpt-5.4-pro");
      expect(unlisted).toMatchObject({ availability: false });
      // The account is signed in; a missing-auth reason would render sign-in guidance.
      expect(unlisted.unavailableReason).toBeUndefined();
      expectAvailable(evaluate([ready], "gpt-5.5"), "openai:chatgpt");
      expectAvailable(
        evaluate([ready, listing("openai:chatgpt", "gpt-5.4-pro")], "gpt-5.4-pro"),
        "openai:chatgpt",
      );
    });

    it.each([
      ["an OpenAI API key is also stored", ready, true],
      [
        "the listing is unavailable",
        { profileId: "openai:chatgpt", status: "unavailable" } as const,
        false,
      ],
    ])("keeps the subscription route when %s", (label, outcome, withApiKey) => {
      expect(evaluate([outcome], "gpt-5.4-pro", { withApiKey }), label).toMatchObject({
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
    ])("uses only the selected account's listing when %s", (label, outcomes, expected) => {
      // Account A's ready listing omits gpt-5.5-pro and gpt-5.5; account B is selected.
      const listed = [listing("openai:a", "gpt-6-sol"), ...outcomes];
      const options = { profileIds: ["openai:a", "openai:b"], pin: "openai:b" };
      expect(evaluate(listed, "gpt-5.5-pro", options), label).toMatchObject(expected);
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
    expectAvailable(owner.evaluateEntry(entry, [entry], "openclaw"), "openai:chosen");
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

function setupClaudeCliBackends() {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolvePluginSetupRegistry: () => createEmptyPluginSetupRegistry(),
    resolveRuntimeCliBackends: createClaudeCliBackends,
  });
}
describe("catalog decisions with prepared CLI auth directories", () => {
  beforeEach(setupClaudeCliBackends);

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
      const stored = storedChoice(true);
      const profiles = { ...stored.profiles, direct: apiKey("anthropic") };
      const orderStore = { ...stored, profiles };
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

  it("follows shared ownership after preparing a legacy inherited directory", async () => {
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

  it("keeps custom agent paths distinct and prepares path changes in a new owner", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" });
      const firstDir = state.path("custom-first");
      const secondDir = state.path("custom-second");
      const replacementDir = state.path("custom-replacement");
      const entries = { first: { agentDir: firstDir }, second: { agentDir: secondDir } };
      const cfg: OpenClawConfig = { agents: { entries } };
      setRuntimeAuthProfileStoreSnapshot(storedChoice(true), firstDir);
      setRuntimeAuthProfileStoreSnapshot(storedChoice(false), secondDir);
      setRuntimeAuthProfileStoreSnapshot(storedChoice(false), replacementDir);
      const first = decisionOwner(cfg, "first", state.workspaceDir);
      const second = decisionOwner(cfg, "second", state.workspaceDir);
      expect(readRow(first, "same-row")).toMatchObject(runtimeAvailable);
      expect(readRow(second, "same-row").evidence).not.toBe("runtime");
      const replacement = decisionOwner(
        { agents: { entries: { ...entries, first: { agentDir: replacementDir } } } },
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
      const runtimes = {
        "anthropic/*": "claude-cli",
        "anthropic/claude-pinned": "claude-cli",
        "anthropic/claude-http": "openclaw",
        "anthropic/claude-typed": undefined,
        "google/*": "google-gemini-cli",
      };
      const stale = model("claude-cli", "claude-stale");
      const gemini = model("google-gemini-cli", "gemini-listed");
      const listedModelIds = ["claude-listed"];
      const listing = { provider: "claude-cli", status: "ready" as const, listedModelIds };
      const menu = (pin?: string) =>
        decisions({
          cfg: runtimeConfig(runtimes),
          workspaceDir: state.workspaceDir,
          snapshot: catalogSnapshot([stale, gemini], {
            routeVariants: [],
            providerOutcomes: [listing],
          }),
          metadataSnapshot: cliMetadata,
          preparedAuthStore: pin ? authStore({ [pin]: apiKey("anthropic") }) : emptyAuth,
          preparedRuntimeAuthModes: { "claude-cli": "oauth", "google-gemini-cli": "oauth" },
          preparedSyntheticAuthComplete: true,
          preferredProfileId: pin,
          pinnedProfileId: pin,
        });
      const owner = menu();
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
      const account = menu("anthropic:work");
      const mythos = { provider: "anthropic", id: "claude-mythos-5" };
      const host = account.evaluateEntry(mythos);
      expectAvailable(host, "anthropic:work");
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
  const listedModelIds = [native.id];
  const listed = { provider: "claude-cli", status: "ready" as const, listedModelIds };
  const snapshot = {
    entries: [native, donor, hostedOnly, model("claude-cli", "claude-stale")],
    routeVariants: [],
    staticEntries: [donor, hostedOnly],
    providerOutcomes: [listed],
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

const ROW_COUNT = 12;
function cooperativeCatalog(visit?: (count: number) => void, extra?: Partial<DecisionParams>) {
  const rows = Array.from(Array<undefined>(ROW_COUNT).keys(), (i) => model("openai", `row-${i}`));
  const routes = vi.fn(() => {
    visit?.(routes.mock.calls.length);
    return dualRoutes;
  });
  const now = () => routes.mock.calls.length * 9;
  const time = vi.spyOn(performance, "now").mockImplementation(now);
  onTestFinished(() => time.mockRestore());
  const snapshot = catalogSnapshot(rows);
  return { owner: decisions({ snapshot, routeResolverFactory: () => routes, ...extra }), routes };
}
const accountState = { layout: "state-only", env: WITHOUT_OPENAI_ENV_AUTH } as const;
const fallback = { supported: false, fallbackRuntime: "openclaw" } as const;
const requestAuthority = { assertCurrent() {} };
type Harness = ReturnType<typeof harnessRegistry>["agentHarnesses"][number]["harness"];
describe("cooperative catalog projection regressions", () => {
  it("runs callbacks between host route evaluations", async () => {
    const { owner, routes } = cooperativeCatalog();
    let interleaved = 0;
    const probe = (async () => {
      for (let i = 0; i < ROW_COUNT; i++) {
        await nextImmediate();
        const count = routes.mock.calls.length;
        interleaved += Number(count > 0 && count < ROW_COUNT);
      }
    })();
    onTestFinished(() => probe);
    expect(await owner.projectCatalog(requestAuthority)).toHaveLength(ROW_COUNT);
    expect(interleaved).toBeGreaterThanOrEqual(3);
  });
  it.each(["authority", "owner", "expiry"] as const)("stops on %s changes", async (change) => {
    let current = true;
    const expiry = Date.now() + 3_600_000;
    using time = vi.spyOn(Date, "now");
    const revoked = new Error("Fixture read revoked");
    const visit = (count: number) => {
      if (count === 3) {
        const invalidation = nextImmediate().then(() => {
          current = false;
          if (change === "expiry") {
            time.mockReturnValue(expiry + 1);
          }
        });
        onTestFinished(() => invalidation);
      }
    };
    const { owner, routes } = cooperativeCatalog(visit, {
      isCurrent: () => change !== "owner" || current,
      preparedAuthStore: authStore({ "openai:fixture": token("synthetic", expiry) }),
    });
    const assertCurrent = () => {
      if (change === "authority" && !current) {
        throw revoked;
      }
    };
    const error = await owner.projectCatalog({ assertCurrent }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(change === "authority" ? Error : SupersededError);
    expect(error === revoked).toBe(change === "authority");
    expect(routes).toHaveBeenCalledTimes(3);
  });
  it("returns a retired owner's rows without caching them", async () => {
    const cfg = runtimeConfig({ "openai/gpt-5.4": "openclaw" });
    const pluginRegistry = harnessRegistry("codex");
    const owner = decisions({ cfg, pluginRegistry, isCurrent: () => false });
    const [first, second] = [await owner.projectCatalog(), await owner.projectCatalog()];
    expect([first.length, second === first, second]).toEqual([1, false, first]);
    const host = owner.evaluateEntry(entry, [entry], "default");
    const runtime = owner.resolveDecisionRuntime(entry, host);
    expect(runtime).toEqual({ id: "openclaw", source: "model" });
  });
  it.each(["withCurrent", "assertCurrent"] as const)(
    "joins both account publications before projecting with %s and no elapsed slice",
    (kind) =>
      withOpenClawTestState(accountState, async ({ workspaceDir }) => {
        const clock = vi.spyOn(performance, "now").mockReturnValue(0);
        onTestFinished(() => clock.mockRestore());
        const { api, baseUrl } = subscriptionRoute;
        const base = { api, baseUrl, contextWindow: 128_000 };
        const entries = ["gpt-5.4", "gpt-5.5-pro"].map((id) => model("openai", id, base));
        const native = { nativeRuntime: "codex", contextWindow: 272_000 };
        const routeVariants = [...entries, ...entries.map((row) => ({ ...row, ...native }))];
        const modelCatalog = catalogSnapshot(entries, { routeVariants });
        const cfg = runtimeConfig({ "openai/gpt-5.4": "codex", "openai/gpt-5.5-pro": "codex" });
        const primary = "openai:primary";
        const sibling = "openai:sibling";
        cfg.agents!.defaults!.workspace = workspaceDir;
        cfg.agents!.defaults!.model = `openai/gpt-5.4@${primary}`;
        const chatgpt = oauth("openai", Date.now() + 3_600_000);
        const profiles = authStore({ [primary]: chatgpt, [sibling]: chatgpt });
        const accountCatalog = createPreparedAccountCatalogAccess(() => true);
        const invoke = accountCatalog.acquire.bind(accountCatalog);
        using acquire = vi.spyOn(accountCatalog, "acquire").mockImplementation(async (req) => {
          await nextImmediate();
          const { profileId } = req;
          const listedModelIds = profileId === sibling ? ["gpt-5.5-pro"] : [];
          const row = {
            provider: "openai",
            profileId,
            status: "ready" as const,
            listedModelIds,
          };
          return invoke({ ...req, refresh: true, allowDiscovery: true, load: async () => [row] });
        });
        const pluginRegistry = harnessRegistry("codex", {
          supports: ({ modelProvider }) =>
            modelProvider?.preparedAuth ? { supported: true } : fallback,
        });
        const owner = {
          ...createChatMetadataOwner(cfg, "gpt-5.4", {}, "openai", api),
          accountCatalog,
          pluginRegistry,
          metadataSnapshot: metadata,
          modelCatalog,
          isCurrent: () => true,
        };
        const routeSpy = vi
          .spyOn(openaiRoutes, "createOpenAIModelRoutesResolver")
          .mockImplementation(
            routeResolverFactory({ ...dualRoutes, preferredAuthRequirement: "subscription" }),
          );
        onTestFinished(() => routeSpy.mockRestore());
        const context = {
          getRuntimeConfig: () => cfg,
          loadGatewayModelCatalogSnapshot: vi.fn(),
          logGateway: { debug: vi.fn() },
        };
        const auth = { authStore: profiles, authModes: {} };
        const facts = { agentId: "main", owner, modelCatalog, ...auth };
        const authority =
          kind === "withCurrent"
            ? { withCurrent: async <T>(consume: () => T): Promise<Awaited<T>> => await consume() }
            : requestAuthority;
        const projection = await prepareChatMetadataModelProjection({
          context,
          facts,
          ...authority,
          preferredProfileId: sibling,
          profileProvider: "openai",
        });
        expect(acquire.mock.calls.map(([r]) => r.profileId)).toEqual([sibling, primary]);
        expect(projection.modelCatalog.map((m) => m.contextWindow)).toEqual([128_000, 272_000]);
        const rows = (projection.read().models ?? []).map((row) => [row.id, row.available]);
        expect(rows).toHaveLength(2);
        expect(Object.fromEntries(rows)).toEqual({ "gpt-5.4": false, "gpt-5.5-pro": true });
      }),
  );
});
describe("cooperative catalog projection compatibility invariants", () => {
  it("selects an available CLI binding without asking the same-named harness", () => {
    setupClaudeCliBackends();
    onTestFinished(() => {
      cliBackendsTesting.resetDepsForTest();
      vi.unstubAllEnvs();
    });
    const row = model("anthropic", "claude-listed");
    const supports = vi.fn(() => ({ supported: false as const }));
    const owner = decisions({
      snapshot: catalogSnapshot([row]),
      pluginRegistry: harnessRegistry("claude-cli", { supports }),
      cfg: runtimeConfig({ "anthropic/claude-listed": "openclaw" }),
      preparedRuntimeAuthModes: { "claude-cli": "oauth" },
      preparedSyntheticAuthComplete: true,
    });
    expect(owner.runtimeChoices(row)).toContain("claude-cli");
    expect(supports).not.toHaveBeenCalled();
  });
  it("keeps authorized results uncached and expired credentials unavailable", async () => {
    const owner = decisions({
      pinnedProfileId: "openai:fixture",
      preparedAuthStore: authStore({ "openai:fixture": token("expired", 1) }),
    });
    const requested = await owner.projectCatalog(requestAuthority);
    const offline = await owner.projectCatalog();
    expect([offline === requested, offline]).toEqual([false, requested]);
    expect(owner.evaluateEntry(entry).availability).toBe(false);
  });
  it("honors auto selection hints, live priorities, and explicit fallback", async () => {
    const base = model("projection-fixture", "model", { contextWindow: 10_000 });
    const hint = { ...base, nativeRuntime: "hinted", contextWindow: 20_000 };
    const preferred = { ...base, nativeRuntime: "preferred", contextWindow: 30_000 };
    const snapshot = catalogSnapshot([base], { routeVariants: [base, hint, preferred] });
    const supports = vi.fn(() => ({ supported: true as const }));
    const registry = harnessRegistry("hinted", { supports });
    const ranked = () => ({ supported: true as const, priority: 5 });
    const other = harnessRegistry("preferred", { supports: ranked });
    registry.agentHarnesses.push(...other.agentHarnesses);
    let priority = 10;
    using hintSpy = vi.spyOn(autoSelection, "resolveAgentHarnessAutoSelectionHint");
    hintSpy.mockImplementation(({ harness }) =>
      harness.id === "hinted" ? { supported: true, priority } : undefined,
    );
    const owner = decisions({ snapshot, pluginRegistry: registry });
    const read = () => owner.projectCatalog(requestAuthority);
    expect(await read()).toMatchObject([{ contextWindow: 20_000 }]);
    priority = 1;
    expect(await read()).toMatchObject([{ contextWindow: 30_000 }]);
    expect(supports).not.toHaveBeenCalled();
    const cfg = runtimeConfig({ "projection-fixture/model": "preferred" });
    const pluginRegistry = harnessRegistry("preferred", { supports: () => fallback });
    const rows = await decisions({ snapshot, cfg, pluginRegistry }).projectCatalog();
    expect(rows).toMatchObject([{ contextWindow: 10_000 }]);
    const unregistered = await decisions({ snapshot, cfg }).projectCatalog();
    expect(unregistered).toMatchObject([{ contextWindow: 30_000 }]);
  });
  it("keeps distinct route policies and provider ownership in harness support", async () => {
    const row = { ...entry, api: platformRoute.api, baseUrl: platformRoute.baseUrl };
    const supports = vi.fn<Harness["supports"]>(({ modelProvider }) => ({
      supported: modelProvider?.runtimePolicy?.compatibleIds.includes("codex") === true,
    }));
    const owner = decisions({
      cfg: config,
      snapshot: catalogSnapshot([row]),
      preparedAuthStore: authStore({ "openai:fixture": apiKey("openai") }),
      pluginRegistry: harnessRegistry("codex", { supports }),
      routeResolverFactory:
        () =>
        ({ observedRoutes }) => {
          const compatibleIds = observedRoutes?.length === 2 ? ["codex"] : ["openclaw", "codex"];
          const routes = [{ ...platformRoute, runtimePolicy: { compatibleIds } }] as const;
          return { ...dualRoutes, routes };
        },
    });
    await owner.projectCatalog(requestAuthority);
    const donor = { ...row, baseUrl: subscriptionRoute.baseUrl };
    expect(owner.runtimeChoices(row, [row, donor])).toContain("codex");
    const facts = supports.mock.calls.map(([ctx]) => [
      Boolean(ctx.providerOwnerStatus),
      ctx.modelProvider?.runtimePolicy?.compatibleIds,
    ]);
    const compatible = [false, ["openclaw", "codex"]];
    expect(facts).toEqual(expect.arrayContaining([compatible, [true, ["codex"]]]));
  });
});
