import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionTranscriptFile } from "../../config/sessions/transcript-file-resolve.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import * as authProfiles from "../auth-profiles/store-runtime.js";
import * as harnessRuntime from "../harness/runtime-plugin.js";
import { loadManifestModelCatalog } from "../model-catalog.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { buildConfiguredModelCatalog } from "../model-selection-shared.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import * as sessionPersistence from "./attempt-execution.shared.js";
import { resolveEmbeddedModelSelection } from "./model-selection.js";
import * as runtimeLoaders from "./runtime-loaders.js";

vi.mock("../model-catalog.js", { spy: true });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:subagent:configured-selection";

function configuredModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 1024,
  };
}

function catalogEntry(provider: string, id: string): ModelCatalogEntry {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: `https://${provider}.invalid/v1`,
    reasoning: false,
    input: ["text"],
  };
}

function automaticEntry(model = "child"): SessionEntry {
  return {
    sessionId: "configured-child",
    updatedAt: 1,
    providerOverride: "custom",
    modelOverride: model,
    modelOverrideSource: "auto",
    modelOverrideRouteResolution: "resolved",
    modelOverrideFallbackOriginProvider: "custom",
    modelOverrideFallbackOriginModel: model,
  };
}

beforeEach(() => {
  vi.spyOn(harnessRuntime, "ensureSelectedAgentHarnessPlugin").mockResolvedValue(undefined);
  vi.spyOn(runtimeLoaders, "loadTranscriptResolveRuntime").mockResolvedValue({
    resolveSessionTranscriptFile: async (params) => ({
      sessionFile: path.join(
        path.dirname(params.storePath ?? "/unused/sessions.json"),
        "turn.jsonl",
      ),
      sessionEntry: params.sessionEntry,
    }),
  });
  // Only the persistence boundary is substituted; the selector decides every patch.
  vi.spyOn(sessionPersistence, "persistAgentSession").mockImplementation(async (params) => {
    const saved = structuredClone(params.entry);
    params.sessionStore[params.sessionKey] = saved;
    return saved;
  });
});

afterEach(() => vi.restoreAllMocks());

function createFixture(options: { manifestOwner?: boolean } = {}) {
  const workspaceDir = tempDirs.make("command-configured-selection-");
  const defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {
    model: { primary: "custom/base" },
    modelPolicy: { allow: ["custom/manual"] },
  };
  const custom: ModelProviderConfig = {
    api: "openai-completions",
    baseUrl: "https://custom.invalid/v1",
    agentRuntime: { id: "openclaw" },
    models: [configuredModel("base"), configuredModel("child"), configuredModel("manual")],
  };
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: { workspace: workspaceDir } },
      defaults,
    },
    models: { providers: { custom } },
  };
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: options.manifestOwner
      ? [
          {
            id: "custom-catalog",
            providers: ["custom"],
            modelCatalog: {
              providers: { custom: { models: [{ id: "child", name: "Manifest child" }] } },
            },
          },
        ]
      : [],
  });
  const registry = createEmptyPluginRegistry();
  const store: Record<string, SessionEntry> = { [sessionKey]: automaticEntry() };
  const entry = () => expectDefined(store[sessionKey], "configured selection fixture session");
  const inventory = vi.mocked(loadManifestModelCatalog).mockImplementation(() => {
    throw new Error("Configured selection must not require unrelated manifest inventory");
  });
  const select = (overrides: Partial<Parameters<typeof resolveEmbeddedModelSelection>[0]> = {}) =>
    withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: registry }, () =>
      resolveEmbeddedModelSelection({
        cfg,
        opts: { message: "Select the configured child", allowModelOverride: false },
        sessionEntry: entry(),
        sessionStore: store,
        sessionKey,
        sessionId: entry().sessionId,
        storePath: path.join(workspaceDir, "sessions.json"),
        sessionAgentId: "main",
        workspaceDir,
        pluginsEnabled: true,
        manifestMetadataSnapshot: metadataSnapshot,
        modelManifestContext: { manifestPlugins: metadataSnapshot },
        configuredThinkingCatalog: buildConfiguredModelCatalog({
          cfg,
          manifestPlugins: metadataSnapshot,
        }),
        isSubagentLane: true,
        suppressVisibleSessionEffects: false,
        runContext: {},
        ...overrides,
      }),
    );
  return { cfg, defaults, custom, store, entry, inventory, registry, select };
}

function createRestrictedFixture() {
  const fixture = createFixture();
  fixture.defaults.model = { primary: "custom/child", fallbacks: ["custom/manual"] };
  fixture.defaults.modelPolicy = { allow: ["custom/*"] };
  fixture.defaults.models = {
    "custom/child": { alias: "blocked" },
    "custom/manual": { alias: "permitted" },
  };
  fixture.inventory.mockReturnValue([
    catalogEntry("custom", "base"),
    catalogEntry("custom", "child"),
    catalogEntry("custom", "manual"),
  ]);
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "limited-operator",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    modelPolicy: prepareOperatorModelPolicy({
      cfg: fixture.cfg,
      policy: { sourceAgent: "main", deny: ["custom/child"] },
    }),
  });
  return { ...fixture, operatorAuthority };
}

describe("command selection with configured model facts", () => {
  it("does not probe a primary excluded by the original operator policy", async () => {
    const fixture = createRestrictedFixture();
    fixture.store[sessionKey] = {
      ...automaticEntry("manual"),
      modelOverrideFallbackOriginModel: "child",
    };
    const selected = await fixture.select({
      opts: { message: "Continue", operatorAuthority: fixture.operatorAuthority },
    });
    expect(selected).toMatchObject({ provider: "custom", model: "manual" });
    expect(selected.autoFallbackPrimaryProbe).toBeUndefined();
  });

  it("keeps an incompatible shared account pin when role policy selects another provider", async () => {
    const fixture = createRestrictedFixture();
    fixture.defaults.model = { primary: "other/default", fallbacks: ["custom/manual"] };
    fixture.defaults.modelPolicy = { allow: ["custom/*", "other/*"] };
    fixture.cfg.models!.providers!.other = {
      ...fixture.custom,
      models: [configuredModel("default")],
    };
    fixture.store[sessionKey] = {
      sessionId: "configured-child",
      updatedAt: 1,
      providerOverride: "other",
      modelOverride: "default",
      modelOverrideSource: "user",
      authProfileOverride: "other:shared",
      authProfileOverrideSource: "user",
    };
    vi.spyOn(authProfiles, "ensureAuthProfileStore").mockReturnValue({
      version: 1,
      profiles: {
        "other:shared": { type: "api_key", provider: "other", key: "synthetic-model-policy-key" },
      },
    });
    const before = structuredClone(fixture.store);

    const selected = await fixture.select({
      opts: { message: "Continue", operatorAuthority: fixture.operatorAuthority },
    });
    expect(selected).toMatchObject({ provider: "custom", model: "manual" });
    expect(selected.sessionEntryForAttempt?.authProfileOverride).toBeUndefined();
    expect(fixture.store).toEqual(before);
  });

  it.each(["custom/child", "blocked"])(
    "rejects a role-denied explicit %s before selection or runtime effects",
    async (model) => {
      const fixture = createRestrictedFixture();
      const before = structuredClone(fixture.store);

      await expect(
        fixture.select({
          opts: {
            message: "Use requested model",
            model,
            allowModelOverride: true,
            operatorAuthority: fixture.operatorAuthority,
          },
        }),
      ).rejects.toThrow("Your operator role cannot use this model");

      expect(fixture.store).toEqual(before);
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
      expect(harnessRuntime.ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "constrains stored automatic selection only for a restricted caller (%s)",
    async (restricted) => {
      const fixture = createRestrictedFixture();
      const selected = await fixture.select({
        opts: {
          message: "Continue",
          ...(restricted ? { operatorAuthority: fixture.operatorAuthority } : {}),
        },
      });

      expect(selected).toMatchObject({
        provider: "custom",
        model: restricted ? "manual" : "child",
      });
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
    },
  );

  it("allows an explicit permitted alias without weakening the agent's manual policy", async () => {
    const fixture = createRestrictedFixture();
    const opts = {
      message: "Use permitted model",
      model: "permitted",
      allowModelOverride: true,
      operatorAuthority: fixture.operatorAuthority,
    };
    expect(await fixture.select({ opts })).toMatchObject({ provider: "custom", model: "manual" });

    fixture.defaults.modelPolicy = { allow: ["custom/base"] };
    await expect(fixture.select({ opts })).rejects.toThrow(
      'Model override "custom/manual" is not allowed',
    );
  });

  it("does not let a model lock bypass the original caller's model policy", async () => {
    const fixture = createRestrictedFixture();
    fixture.entry().modelSelectionLocked = true;
    const before = structuredClone(fixture.store);

    await expect(
      fixture.select({
        opts: { message: "Continue", operatorAuthority: fixture.operatorAuthority },
      }),
    ).rejects.toThrow("Your operator role cannot use this model");

    expect(fixture.store).toEqual(before);
    expect(harnessRuntime.ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
  });

  it("preserves an explicit CLI route across resumed command turns and a later API selection", async () => {
    const fixture = createFixture();
    fixture.defaults.modelPolicy = { allow: ["custom-cli/child", "custom/child"] };
    const select = () => fixture.select({ pluginsEnabled: false, requestedThinkLevel: "off" });
    fixture.registry.cliBackends.push({
      pluginId: "custom",
      source: "fixture",
      backend: {
        id: "custom-cli",
        modelProvider: "custom",
        config: { command: "custom-cli" },
      },
    });
    fixture.inventory.mockReturnValue([catalogEntry("custom-cli", "child")]);
    fixture.store[sessionKey] = {
      sessionId: "configured-child",
      updatedAt: 1,
      providerOverride: "custom-cli",
      modelOverride: "child",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    };

    expect(await select()).toMatchObject({ provider: "custom-cli", model: "child" });
    fixture.entry().cliSessionBindings = { "custom-cli": { sessionId: "native-command-session" } };
    expect(await select()).toMatchObject({ provider: "custom-cli", model: "child" });
    fixture.entry().providerOverride = "custom";
    expect(await select()).toMatchObject({ provider: "custom", model: "child" });
  });

  it("retains a resolved self-origin child outside manual policy without manifest inventory", async () => {
    const fixture = createFixture();
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });
    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "custom",
      model: "child",
      requestedRouteResolution: "resolved",
      storedModelOverrideSource: "auto",
      effectiveTurnThinkLevel: "off",
      sessionEntry: automaticEntry(),
      sessionEntryForAttempt: automaticEntry(),
    });
    expect(selected.autoFallbackPrimaryProbe).toBeUndefined();
    expect(selected.thinkingCatalog).toContainEqual(
      expect.objectContaining({
        provider: "custom",
        id: "child",
        reasoning: false,
        configuredReasoning: false,
        api: "openai-completions",
        baseUrl: "https://custom.invalid/v1",
      }),
    );
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });

  it("retains declared capabilities for an unrestricted unconfigured selection", async () => {
    const fixture = createFixture();
    delete fixture.defaults.modelPolicy;
    fixture.defaults.model = { primary: "remote/unconfigured" };
    delete fixture.cfg.models;
    fixture.store[sessionKey] = { sessionId: "configured-child", updatedAt: 1 };
    const declared: ModelCatalogEntry = {
      ...catalogEntry("remote", "unconfigured"),
      input: ["text", "image"],
    };
    fixture.inventory.mockReturnValue([declared]);
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

    const selected = await fixture.select({
      configuredThinkingCatalog: [],
      requestedThinkLevel: "off",
    });

    expect(selected).toMatchObject({
      provider: "remote",
      model: "unconfigured",
      effectiveTurnThinkLevel: "off",
    });
    expect(selected.thinkingCatalog).toContainEqual(expect.objectContaining(declared));
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });

  it.each(["raw", "resolved"] as const)(
    "keeps a literal configured model that collides with an alias (%s stored route)",
    async (route) => {
      const fixture = createFixture();
      fixture.defaults.modelPolicy = {
        allow: ["custom/base", "custom/alias", "custom/actual"],
      };
      fixture.defaults.models = { "custom/actual": { alias: "alias" } };
      fixture.custom.models.push(configuredModel("alias"), configuredModel("actual"));
      fixture.store[sessionKey] =
        route === "raw"
          ? {
              sessionId: "configured-child",
              updatedAt: 1,
              providerOverride: "custom",
              modelOverride: "alias",
              modelOverrideSource: "user",
              modelSelectionLocked: true,
            }
          : automaticEntry("alias");
      fixture.inventory.mockReturnValue([catalogEntry("custom", "alias")]);
      const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

      const selected = await fixture.select();

      expect(selected).toMatchObject({
        provider: "custom",
        model: "alias",
        requestedRouteResolution: "resolved",
      });
      expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    },
  );

  it.each([
    { permission: false, error: "Model override is not authorized for this caller." },
    { permission: true, error: 'Model override "custom/child" is not allowed' },
  ])(
    "does not convert automatic child provenance into explicit override permission ($permission)",
    async ({ permission, error }) => {
      const fixture = createFixture();
      fixture.inventory.mockReturnValue([catalogEntry("custom", "child")]);
      const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

      await expect(
        fixture.select({
          opts: {
            message: "Explicit override",
            provider: "custom",
            model: "child",
            allowModelOverride: permission,
          },
        }),
      ).rejects.toThrow(error);

      expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    },
  );

  it.each([false, true])(
    "keeps wildcard replacement in catalog order (reversed=%s)",
    async (reverse) => {
      const fixture = createFixture();
      fixture.defaults.modelPolicy = { allow: ["remote/*"] };
      fixture.store[sessionKey] = { sessionId: "configured-child", updatedAt: 1 };
      const choices = [catalogEntry("remote", "z-first"), catalogEntry("remote", "a-second")];
      const catalog = reverse ? choices.toReversed() : choices;
      fixture.inventory.mockReturnValue(catalog);
      const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

      const selected = await fixture.select();

      expect(selected).toMatchObject({
        provider: "remote",
        model: reverse ? "a-second" : "z-first",
        requestedRouteResolution: "resolved",
      });
      expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    },
  );

  it("retains unqualified policy inference from the manifest catalog", async () => {
    const fixture = createFixture();
    delete fixture.defaults.modelPolicy;
    fixture.defaults.models = { shared: {} };
    fixture.store[sessionKey] = {
      sessionId: "configured-child",
      updatedAt: 1,
      providerOverride: "remote",
      modelOverride: "shared",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    };
    fixture.inventory.mockReturnValue([catalogEntry("remote", "shared")]);
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "remote",
      model: "shared",
      requestedRouteResolution: "resolved",
    });
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
  });

  it.each(["incomplete", "inherited"] as const)(
    "does not grant the child's automatic-policy exemption to %s provenance",
    async (provenance) => {
      const fixture = createFixture();
      fixture.inventory.mockReturnValue([
        catalogEntry("custom", "base"),
        catalogEntry("custom", "child"),
      ]);
      if (provenance === "incomplete") {
        delete fixture.entry().modelOverrideFallbackOriginModel;
      } else {
        const parentKey = "agent:main:parent";
        fixture.store[parentKey] = { ...automaticEntry(), sessionId: "parent" };
        fixture.store[sessionKey] = {
          sessionId: "configured-child",
          updatedAt: 1,
          parentSessionKey: parentKey,
        };
      }
      const configBefore = structuredClone(fixture.cfg);
      const parentBefore = structuredClone(fixture.store["agent:main:parent"]);

      const selected = await fixture.select();

      expect(selected).toMatchObject({
        provider: "custom",
        model: "base",
        requestedRouteResolution: "resolved",
      });
      expect(selected.sessionEntry?.modelOverride).toBeUndefined();
      expect(fixture.entry().modelOverride).toBeUndefined();
      expect(fixture.store["agent:main:parent"]).toEqual(parentBefore);
      expect(fixture.cfg).toEqual(configBefore);
    },
  );

  it("retains manifest-owned donor facts for a configured automatic child", async () => {
    const fixture = createFixture({ manifestOwner: true });
    fixture.inventory.mockReturnValue([
      {
        ...catalogEntry("custom", "child"),
        baseUrl: "https://donor.invalid/v1",
        contextWindow: 32_768,
      },
    ]);
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "custom",
      model: "child",
      requestedRouteResolution: "resolved",
      effectiveTurnThinkLevel: "off",
    });
    expect(selected.thinkingCatalog).toContainEqual(
      expect.objectContaining({
        provider: "custom",
        id: "child",
        baseUrl: "https://donor.invalid/v1",
        contextWindow: 32_768,
        configuredReasoning: false,
      }),
    );
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
  });
});

describe("command selection with real transcript routing", () => {
  it.each([
    [sessionKey, true, false, "store"],
    [sessionKey, true, true, "suppressed"],
    [sessionKey, false, false, "fallback"],
    [sessionKey, false, true, "fallback"],
    [undefined, true, false, "fallback"],
    [undefined, true, true, "fallback"],
    [undefined, false, false, "fallback"],
    [undefined, false, true, "fallback"],
    ["", true, false, "fallback"],
    ["", true, true, "fallback"],
    ["", false, false, "fallback"],
    ["", false, true, "fallback"],
  ] as const)(
    "routes key=%j, store=%s, suppressed=%s through the real resolver",
    async (key, withStore, suppressVisibleSessionEffects, route) => {
      const fixture = createFixture();
      fixture.defaults.modelPolicy = { allow: ["custom/*"] };
      fixture.inventory.mockReturnValue([catalogEntry("custom", "base")]);
      const sessionId = "routing-session";
      const storedEntry: SessionEntry = { sessionId: "stored-session", updatedAt: 2 };
      const store = {
        [sessionKey]: storedEntry,
        [sessionId]: { sessionId: "not-a-keyed-session", updatedAt: 3 },
        "": { sessionId: "not-an-empty-key-session", updatedAt: 4 },
      };
      const storePath = path.join(fixture.cfg.agents!.entries!.main!.workspace!, "sessions.json");
      const resolver = vi.fn(resolveSessionTranscriptFile);
      vi.mocked(runtimeLoaders.loadTranscriptResolveRuntime).mockResolvedValue({
        resolveSessionTranscriptFile: resolver,
      });

      const selected = await fixture.select({
        opts: { message: "Resolve transcript routing", threadId: 42 },
        sessionId,
        sessionKey: key,
        sessionEntry: undefined,
        sessionStore: withStore ? store : undefined,
        storePath,
        suppressVisibleSessionEffects,
      });

      expect(selected.sessionFile).toBe(key === undefined ? sessionId : key);
      expect(selected.sessionEntry).toBe(route === "store" ? storedEntry : undefined);
      expect(selected.sessionEntryForAttempt).toBeUndefined();
      expect(resolver).toHaveBeenCalledTimes(1);
      const forwarded = expectDefined(resolver.mock.calls[0], "transcript resolution call")[0];
      expect(forwarded).toMatchObject({
        sessionId,
        sessionKey: key === undefined ? sessionId : key,
        agentId: "main",
        threadId: 42,
      });
      expect(forwarded.sessionEntry).toBeUndefined();
      expect(forwarded.sessionStore).toBe(route === "store" ? store : undefined);
      expect(forwarded.storePath).toBe(route === "suppressed" ? undefined : storePath);
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
    },
  );

  it("keeps the explicit entry ahead of the store and preserves the attempt entry", async () => {
    const fixture = createFixture();
    fixture.defaults.modelPolicy = { allow: ["custom/*"] };
    fixture.inventory.mockReturnValue([catalogEntry("custom", "base")]);
    const explicitEntry: SessionEntry = { sessionId: "explicit-session", updatedAt: 1 };
    const storedEntry = fixture.entry();
    const resolver = vi.fn(resolveSessionTranscriptFile);
    vi.mocked(runtimeLoaders.loadTranscriptResolveRuntime).mockResolvedValue({
      resolveSessionTranscriptFile: resolver,
    });

    const selected = await fixture.select({ sessionEntry: explicitEntry });

    expect(selected.sessionFile).toBe(sessionKey);
    expect(selected.sessionEntry).toBe(explicitEntry);
    expect(selected.sessionEntryForAttempt).toBe(explicitEntry);
    expect(fixture.entry()).toBe(storedEntry);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });

  it("rechecks operator authority after loading transcript routing", async () => {
    const fixture = createFixture();
    const lifetime = new AbortController();
    const denied = new Error("operator authority ended during transcript loading");
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "transcript-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      signal: lifetime.signal,
    });
    const resolver = vi.fn(resolveSessionTranscriptFile);
    vi.mocked(runtimeLoaders.loadTranscriptResolveRuntime).mockImplementation(async () => {
      lifetime.abort(denied);
      return { resolveSessionTranscriptFile: resolver };
    });

    await expect(
      fixture.select({ opts: { message: "Resolve transcript routing", operatorAuthority } }),
    ).rejects.toBe(denied);

    expect(runtimeLoaders.loadTranscriptResolveRuntime).toHaveBeenCalledTimes(1);
    expect(resolver).not.toHaveBeenCalled();
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });
});
