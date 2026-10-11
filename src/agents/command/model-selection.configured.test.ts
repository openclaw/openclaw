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
import { loadProviderScopedThinkingCatalog } from "../model-catalog.runtime.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { buildConfiguredModelCatalog } from "../model-selection-shared.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import * as sessionPersistence from "./attempt-execution.shared.js";
import { resolveEmbeddedModelSelection } from "./model-selection.js";
import * as runtimeLoaders from "./runtime-loaders.js";

vi.mock("../model-catalog.js", { spy: true });
vi.mock("../model-catalog.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-catalog.runtime.js")>();
  return {
    ...actual,
    loadProviderScopedThinkingCatalog: vi.fn().mockResolvedValue([]),
  };
});

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
    resolveSessionTranscriptFile,
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
  it.each([
    { previous: null, observed: "max", configured: undefined, supported: true },
    { previous: "max", observed: null, configured: undefined, supported: false },
    { previous: null, observed: "max", configured: null, supported: false },
    { previous: "max", observed: null, configured: "max", supported: true },
    { previous: "max", observed: undefined, configured: undefined, supported: true },
  ])(
    "uses observed max support ($supported) over stale catalog facts",
    async ({ previous, observed, configured, supported }) => {
      const fixture = createFixture();
      fixture.custom.models.forEach((model) => {
        model.reasoning = true;
        if (model.id === "child" && configured !== undefined) {
          model.thinkingLevelMap = { max: configured };
        }
      });
      fixture.defaults.modelPolicy = { allow: ["custom/*"] };
      const stale = {
        ...catalogEntry("custom", "child"),
        reasoning: true,
        thinkingLevelMap: { max: previous },
      };
      fixture.inventory.mockReturnValue([stale]);
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue(
        observed === undefined ? [] : [{ ...stale, thinkingLevelMap: { max: observed } }],
      );
      const selection = fixture.select({
        configuredThinkingCatalog: [stale],
        requestedThinkLevel: "max",
        thinkOnce: "max",
        isSubagentLane: false,
      });
      if (supported) {
        await expect(selection).resolves.toMatchObject({ provider: "custom", model: "child" });
      } else {
        await expect(selection).rejects.toThrow('Thinking level "max" is not supported');
      }
    },
  );

  it.each(["fallback", "automatic"] as const)(
    "constrains stored %s selection without probing a role-denied primary",
    async (source) => {
      const fixture = createRestrictedFixture();
      if (source === "fallback") {
        fixture.store[sessionKey] = {
          ...automaticEntry("manual"),
          modelOverrideFallbackOriginModel: "child",
        };
      }
      const selected = await fixture.select({
        opts: { message: "Continue", operatorAuthority: fixture.operatorAuthority },
      });
      expect(selected).toMatchObject({ provider: "custom", model: "manual" });
      expect(selected.autoFallbackPrimaryProbe).toBeUndefined();
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
    },
  );

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

  it.each(["custom/child", "blocked", "locked"])(
    "rejects a role-denied %s selection before runtime effects",
    async (model) => {
      const fixture = createRestrictedFixture();
      if (model === "locked") {
        fixture.entry().modelSelectionLocked = true;
      }
      const before = structuredClone(fixture.store);
      await expect(
        fixture.select({
          opts: {
            message: "Use requested model",
            ...(model === "locked" ? {} : { model, allowModelOverride: true }),
            operatorAuthority: fixture.operatorAuthority,
          },
        }),
      ).rejects.toThrow("Your operator role cannot use this model");
      expect(fixture.store).toEqual(before);
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
      expect(harnessRuntime.ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
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

  it.each([false, true])(
    "retains configured automatic child facts with manifest owner=%s",
    async (manifestOwner) => {
      const fixture = createFixture({ manifestOwner });
      if (manifestOwner) {
        fixture.inventory.mockReturnValue([
          {
            ...catalogEntry("custom", "child"),
            baseUrl: "https://donor.invalid/v1",
            contextWindow: 32_768,
          },
        ]);
      }
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
          configuredReasoning: false,
          ...(manifestOwner
            ? { baseUrl: "https://donor.invalid/v1", contextWindow: 32_768 }
            : {
                reasoning: false,
                api: "openai-completions",
                baseUrl: "https://custom.invalid/v1",
              }),
        }),
      );
      expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unconfigured", "unconfigured"],
    ["wildcard", "z-first"],
    ["unqualified", "shared"],
  ] as const)("selects the manifest catalog's %s route", async (mode, model) => {
    const fixture = createFixture();
    const declared: ModelCatalogEntry = {
      ...catalogEntry("remote", model),
      input: ["text", "image"],
    };
    fixture.store[sessionKey] = { sessionId: "configured-child", updatedAt: 1 };
    if (mode === "wildcard") {
      fixture.defaults.modelPolicy = { allow: ["remote/*"] };
      fixture.inventory.mockReturnValue([
        catalogEntry("remote", "z-first"),
        catalogEntry("remote", "a-second"),
      ]);
    } else {
      delete fixture.defaults.modelPolicy;
      if (mode === "unconfigured") {
        fixture.defaults.model = { primary: "remote/unconfigured" };
        delete fixture.cfg.models;
        fixture.inventory.mockReturnValue([declared]);
      } else {
        fixture.defaults.models = { shared: {} };
        fixture.store[sessionKey] = {
          ...fixture.entry(),
          providerOverride: "remote",
          modelOverride: "shared",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        };
        fixture.inventory.mockReturnValue([catalogEntry("remote", "shared")]);
      }
    }
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });
    const selected = await fixture.select(
      mode === "unconfigured" ? { configuredThinkingCatalog: [], requestedThinkLevel: "off" } : {},
    );
    expect(selected).toMatchObject({
      provider: "remote",
      model,
      requestedRouteResolution: "resolved",
    });
    if (mode === "unconfigured") {
      expect(selected.effectiveTurnThinkLevel).toBe("off");
      expect(selected.thinkingCatalog).toContainEqual(expect.objectContaining(declared));
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
    }
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
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
});

describe("command selection with real transcript routing", () => {
  it.each([
    [sessionKey, true, false, "store"],
    [sessionKey, true, false, "explicit"],
    [sessionKey, true, true, "suppressed"],
    [sessionKey, false, true, "fallback"],
    [undefined, true, true, "fallback"],
    ["", true, true, "fallback"],
  ] as const)(
    "routes key=%j, store=%s, suppressed=%s through the real resolver",
    async (key, withStore, suppressVisibleSessionEffects, route) => {
      const fixture = createFixture();
      fixture.defaults.modelPolicy = { allow: ["custom/*"] };
      fixture.inventory.mockReturnValue([catalogEntry("custom", "base")]);
      const sessionId = "routing-session";
      const storedEntry: SessionEntry =
        route === "explicit" ? fixture.entry() : { sessionId: "stored-session", updatedAt: 2 };
      const store = {
        [sessionKey]: storedEntry,
        [sessionId]: { sessionId: "not-a-keyed-session", updatedAt: 3 },
        "": { sessionId: "not-an-empty-key-session", updatedAt: 4 },
      };
      const explicitEntry: SessionEntry | undefined =
        route === "explicit" ? { sessionId: "explicit-session", updatedAt: 1 } : undefined;
      const storePath = path.join(fixture.cfg.agents!.entries!.main!.workspace!, "sessions.json");
      const resolver = vi.fn(resolveSessionTranscriptFile);
      vi.mocked(runtimeLoaders.loadTranscriptResolveRuntime).mockResolvedValue({
        resolveSessionTranscriptFile: resolver,
      });

      const selected = await fixture.select({
        opts: { message: "Resolve transcript routing", threadId: 42 },
        sessionId,
        sessionKey: key,
        sessionEntry: explicitEntry,
        sessionStore: withStore ? store : undefined,
        storePath,
        suppressVisibleSessionEffects,
      });

      expect(selected.sessionFile).toBe(key === undefined ? sessionId : key);
      expect(selected.sessionEntry).toBe(
        explicitEntry ?? (route === "store" ? storedEntry : undefined),
      );
      expect(selected.sessionEntryForAttempt).toBe(explicitEntry);
      expect(store[sessionKey]).toBe(storedEntry);
      if (route === "explicit") {
        expect(fixture.entry()).toBe(storedEntry);
      }
      expect(resolver).toHaveBeenCalledTimes(1);
      const forwarded = expectDefined(resolver.mock.calls[0], "transcript resolution call")[0];
      expect(forwarded).toMatchObject({
        sessionKey: key === undefined ? sessionId : key,
      });
      expect(forwarded.sessionEntry).toBe(explicitEntry);
      expect(forwarded.sessionStore).toBe(
        route === "store" || route === "explicit" ? store : undefined,
      );
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
    },
  );

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
