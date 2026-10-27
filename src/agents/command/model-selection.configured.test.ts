import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  TURN_MODEL_DEFAULT_REF,
  TURN_MODEL_DIFFERENTIAL_FIXTURES,
  TURN_MODEL_OVERRIDE_REF,
  turnModelRefLabel,
  turnModelVerdict,
} from "../../test-utils/turn-model-selection-differential.js";
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
    ...modelFacts(id),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 1024,
  };
}

function modelFacts(id: string) {
  return { id, name: id, reasoning: false, input: ["text" as const] };
}

function catalogEntry(provider: string, id: string): ModelCatalogEntry {
  return {
    ...modelFacts(id),
    provider,
    api: "openai-completions",
    baseUrl: `https://${provider}.invalid/v1`,
  };
}

function automaticEntry(model = "child"): SessionEntry {
  return {
    ...sessionEntry({ providerOverride: "custom", modelOverride: model }),
    modelOverrideSource: "auto",
    modelOverrideRouteResolution: "resolved",
    modelOverrideFallbackOriginProvider: "custom",
    modelOverrideFallbackOriginModel: model,
  };
}

function sessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "configured-child", updatedAt: 1, ...overrides };
}

function customCatalog(...models: string[]) {
  return models.map((model) => catalogEntry("custom", model));
}

function expectedRoute(model: string, provider = "custom") {
  return { provider, model, requestedRouteResolution: "resolved" };
}

beforeEach(() => {
  vi.spyOn(harnessRuntime, "ensureSelectedAgentHarnessPlugin").mockResolvedValue(undefined);
  // Only the persistence boundary is substituted; the selector decides every patch.
  vi.spyOn(sessionPersistence, "persistAgentSession").mockImplementation(async (params) => {
    const saved = structuredClone(params.entry);
    params.sessionStore[params.sessionKey] = saved;
    return saved;
  });
});

afterEach(() => vi.restoreAllMocks());

function createFixture(options: { manifestOwner?: boolean; sessionKey?: string } = {}) {
  const key = options.sessionKey ?? sessionKey;
  const workspaceDir = tempDirs.make("command-configured-selection-");
  const defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {
    model: { primary: "custom/base" },
    modelPolicy: { allow: ["custom/manual"] },
  };
  const custom: ModelProviderConfig = {
    api: "openai-completions",
    baseUrl: "https://custom.invalid/v1",
    agentRuntime: { id: "openclaw" },
    models: ["base", "child", "manual"].map(configuredModel),
  };
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { workspace: workspaceDir } }, defaults },
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
  const store: Record<string, SessionEntry> = { [key]: automaticEntry() };
  const entry = () => expectDefined(store[key], "configured selection fixture session");
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
        sessionKey: key,
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
  const unchanged = (overrides: Parameters<typeof select>[0] = {}) => {
    const before = structuredClone({ cfg, store });
    return select(overrides).finally(() => expect({ cfg, store }).toEqual(before));
  };
  const userSelection = (model: string, provider = "custom", extra: Partial<SessionEntry> = {}) => {
    store[key] = sessionEntry({
      providerOverride: provider,
      modelOverride: model,
      modelOverrideSource: "user",
      ...extra,
    });
  };
  return {
    cfg,
    defaults,
    custom,
    store,
    entry,
    inventory,
    registry,
    select,
    unchanged,
    userSelection,
  };
}

function createRestrictedFixture() {
  const fixture = createFixture();
  fixture.defaults.model = { primary: "custom/child", fallbacks: ["custom/manual"] };
  fixture.defaults.modelPolicy = { allow: ["custom/*"] };
  fixture.defaults.models = {
    "custom/child": { alias: "blocked" },
    "custom/manual": { alias: "permitted" },
  };
  fixture.inventory.mockReturnValue(customCatalog("base", "child", "manual"));
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "limited-operator",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    modelPolicy: prepareOperatorModelPolicy({
      cfg: fixture.cfg,
      policy: { sourceAgent: "main", deny: ["custom/child"] },
    }),
  });
  const opts = { message: "Continue", operatorAuthority };
  return { ...fixture, operatorAuthority, opts };
}

describe("command selection with configured model facts", () => {
  it.each([
    { previous: null, observed: "max", configured: undefined, supported: true },
    { previous: "max", observed: null, configured: undefined, supported: false },
    { previous: null, observed: "max", configured: null, supported: false },
    { previous: "max", observed: null, configured: "max", supported: true },
    { previous: "max", observed: undefined, configured: undefined, supported: true },
  ])(
    "prefers observed max support ($supported) to stale facts",
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
    "constrains %s without probing the denied primary",
    async (source) => {
      const fixture = createRestrictedFixture();
      if (source === "fallback") {
        fixture.store[sessionKey] = {
          ...automaticEntry("manual"),
          modelOverrideFallbackOriginModel: "child",
        };
      }
      const selected = await fixture.select({ opts: fixture.opts });
      expect(selected).toMatchObject({ provider: "custom", model: "manual" });
      expect(selected.autoFallbackPrimaryProbe).toBeUndefined();
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
    },
  );

  it("preserves the shared account pin across a role-selected provider change", async () => {
    const fixture = createRestrictedFixture();
    fixture.defaults.model = { primary: "other/default", fallbacks: ["custom/manual"] };
    fixture.defaults.modelPolicy = { allow: ["custom/*", "other/*"] };
    fixture.cfg.models!.providers!.other = {
      ...fixture.custom,
      models: [configuredModel("default")],
    };
    fixture.userSelection("default", "other", {
      authProfileOverride: "other:shared",
      authProfileOverrideSource: "user",
    });
    vi.spyOn(authProfiles, "ensureAuthProfileStoreAsync").mockResolvedValue({
      version: 1,
      profiles: {
        "other:shared": { type: "api_key", provider: "other", key: "synthetic-model-policy-key" },
      },
    });
    const selected = await fixture.unchanged({ opts: fixture.opts });
    expect(selected).toMatchObject({ provider: "custom", model: "manual" });
    expect(selected.sessionEntryForAttempt?.authProfileOverride).toBeUndefined();
  });

  it("preserves a prepared missing personal account pin without main-thread SQL", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = createFixture();
      fixture.defaults.modelPolicy = { allow: ["custom/*"] };
      fixture.inventory.mockReturnValue(customCatalog("base", "child", "manual"));
      const owner = ensureProfileForEmail("missing-model-pin@example.test");
      const profileId = `personal:${owner.id}:00000000-0000-4000-8000-000000000001`;
      fixture.userSelection("child", "custom", {
        authProfileOverride: profileId,
        authProfileOverrideSource: "user",
      });
      const sql = observeMainThreadSql();
      sql.calibrate();
      const ensureStore = authProfiles.ensureAuthProfileStoreAsync;
      const prepared = vi
        .spyOn(authProfiles, "ensureAuthProfileStoreAsync")
        .mockImplementation(async (...args) => {
          const store = await ensureStore(...args);
          // Shared-store preparation retains native compatibility reads; selection uses its facts.
          sql.clear();
          return store;
        });
      try {
        const selected = await fixture.unchanged();
        expect(prepared).toHaveBeenCalledOnce();
        expect(selected).toMatchObject({
          ...expectedRoute("child"),
          sessionEntryForAttempt: {
            authProfileOverride: profileId,
            authProfileOverrideSource: "user",
          },
        });
        sql.expectIdle();
      } finally {
        prepared.mockRestore();
        sql.restore();
      }
    });
  });

  it.each(["custom/child", "blocked", "locked"])(
    "rejects a role-denied %s selection before runtime effects",
    async (model) => {
      const fixture = createRestrictedFixture();
      if (model === "locked") {
        fixture.entry().modelSelectionLocked = true;
      }
      await expect(
        fixture.unchanged({
          opts: {
            ...fixture.opts,
            ...(model === "locked" ? {} : { model, allowModelOverride: true }),
          },
        }),
      ).rejects.toThrow("Your operator role cannot use this model");
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
      expect(harnessRuntime.ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
    },
  );

  it("applies both operator and agent policy to a permitted alias", async () => {
    const fixture = createRestrictedFixture();
    const opts = {
      ...fixture.opts,
      model: "permitted",
      allowModelOverride: true,
    };
    expect(await fixture.select({ opts })).toMatchObject({ provider: "custom", model: "manual" });

    fixture.defaults.modelPolicy = { allow: ["custom/base"] };
    await expect(fixture.select({ opts })).rejects.toThrow(
      'Model override "custom/manual" is not allowed',
    );
  });

  it("preserves CLI routing on resume and allows a later API selection", async () => {
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
    fixture.userSelection("child", "custom-cli", {
      modelOverrideRouteResolution: "resolved",
    });

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
      const selected = await fixture.unchanged();
      expect(selected).toMatchObject({
        ...expectedRoute("child"),
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
    fixture.store[sessionKey] = sessionEntry();
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
        fixture.userSelection("shared", "remote", {
          modelOverrideRouteResolution: "resolved",
        });
        fixture.inventory.mockReturnValue([catalogEntry("remote", "shared")]);
      }
    }
    const selected = await fixture.unchanged(
      mode === "unconfigured" ? { configuredThinkingCatalog: [], requestedThinkLevel: "off" } : {},
    );
    expect(selected).toMatchObject(expectedRoute(model, "remote"));
    if (mode === "unconfigured") {
      expect(selected.effectiveTurnThinkLevel).toBe("off");
      expect(selected.thinkingCatalog).toContainEqual(expect.objectContaining(declared));
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
    }
  });

  it("reports the configured default replaced by a wildcard catalog route", async () => {
    const capture = createWarnLogCapture("command-model-fallback");
    try {
      const fixture = createFixture();
      fixture.store[sessionKey] = sessionEntry();
      fixture.defaults.modelPolicy = { allow: ["remote/*"] };
      fixture.inventory.mockReturnValue([
        catalogEntry("remote", "z-first"),
        catalogEntry("remote", "a-second"),
      ]);
      expect(await fixture.unchanged()).toMatchObject(expectedRoute("z-first", "remote"));
      expect(await capture.findText("Falling back to")).toContain('"custom/base"');
      expect(await capture.findText("Falling back to")).toContain('"remote/z-first"');
    } finally {
      capture.cleanup();
    }
  });

  it("keeps a literal catalog model over its alias", async () => {
    const fixture = createFixture();
    fixture.defaults.modelPolicy = { allow: ["custom/base", "custom/alias", "custom/actual"] };
    fixture.defaults.models = { "custom/actual": { alias: "alias" } };
    fixture.custom.models.push(configuredModel("alias"), configuredModel("actual"));
    fixture.store[sessionKey] = automaticEntry("alias");
    fixture.inventory.mockReturnValue([catalogEntry("custom", "alias")]);
    expect(await fixture.unchanged()).toMatchObject(expectedRoute("alias"));
  });

  it.each([
    { permission: false, error: "Model override is not authorized for this caller." },
    { permission: true, error: 'Model override "custom/child" is not allowed' },
  ])(
    "does not treat automatic provenance as override permission ($permission)",
    async ({ permission, error }) => {
      const fixture = createFixture();
      fixture.inventory.mockReturnValue(customCatalog("child"));
      await expect(
        fixture.unchanged({
          opts: {
            message: "Explicit override",
            provider: "custom",
            model: "child",
            allowModelOverride: permission,
          },
        }),
      ).rejects.toThrow(error);
    },
  );

  it.each(["incomplete", "inherited"] as const)(
    "denies the automatic-policy exemption to %s provenance",
    async (provenance) => {
      const fixture = createFixture();
      fixture.inventory.mockReturnValue(customCatalog("base", "child"));
      if (provenance === "incomplete") {
        delete fixture.entry().modelOverrideFallbackOriginModel;
      } else {
        const parentKey = "agent:main:parent";
        fixture.store[parentKey] = { ...automaticEntry(), sessionId: "parent" };
        fixture.store[sessionKey] = sessionEntry({ parentSessionKey: parentKey });
      }
      const configBefore = structuredClone(fixture.cfg);
      const parentBefore = structuredClone(fixture.store["agent:main:parent"]);

      const selected = await fixture.select();

      expect(selected).toMatchObject(expectedRoute("base"));
      expect(selected.sessionEntry?.modelOverride).toBeUndefined();
      expect(fixture.entry().modelOverride).toBeUndefined();
      expect(fixture.store["agent:main:parent"]).toEqual(parentBefore);
      expect(fixture.cfg).toEqual(configBefore);
    },
  );
});

describe("command selection with session routing", () => {
  it.each(TURN_MODEL_DIFFERENTIAL_FIXTURES)("pins observed $name behavior", async (fixture) => {
    const key = "agent:main:telegram:group:selection";
    const harness = createFixture({ sessionKey: key });
    harness.defaults.model = { primary: turnModelRefLabel(TURN_MODEL_DEFAULT_REF) };
    delete harness.defaults.modelPolicy;
    delete harness.cfg.models;
    harness.cfg.channels = fixture.modelByChannel
      ? { modelByChannel: fixture.modelByChannel }
      : undefined;
    const child = structuredClone(fixture.child);
    harness.store[key] = child;
    if (fixture.parent) {
      harness.store[fixture.parent.key] = structuredClone(fixture.parent.entry);
    }
    const selection = await harness.unchanged({
      opts: {
        message: "hello",
        to: "target",
        channel: fixture.ctx.Provider,
        messageChannel: fixture.ctx.Provider,
        groupId: child.groupId,
        groupChannel: child.groupChannel,
        ...(fixture.turnModelOverride
          ? { ...TURN_MODEL_OVERRIDE_REF, allowModelOverride: true }
          : {}),
      },
      pluginsEnabled: false,
      configuredThinkingCatalog: [],
      requestedThinkLevel: "off",
      isSubagentLane: false,
      suppressVisibleSessionEffects: true,
      runContext: {
        messageChannel: fixture.ctx.Provider,
        groupId: child.groupId,
        groupChannel: child.groupChannel,
        currentChannelId: "target",
      },
    });
    expect(
      turnModelVerdict(
        { provider: selection.provider, model: selection.model },
        fixture.locked ? "locked" : fixture.turnModelOverride ? "explicit" : undefined,
      ),
    ).toEqual(fixture.expected.command);
  });

  it.each([
    [sessionKey, false, "store"],
    [sessionKey, false, "explicit"],
    [sessionKey, true, "suppressed"],
    [undefined, true, "fallback"],
  ] as const)(
    "routes key=%j, suppressed=%s (%s)",
    async (key, suppressVisibleSessionEffects, route) => {
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

      const selected = await fixture.select({
        opts: { message: "Resolve transcript routing", threadId: 42 },
        sessionId,
        sessionKey: key,
        sessionEntry: explicitEntry,
        sessionStore: store,
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
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
    },
  );

  it("rechecks operator authority after loading the thinking catalog", async () => {
    const fixture = createFixture();
    fixture.custom.models.forEach((model) => {
      model.reasoning = true;
    });
    const lifetime = new AbortController();
    const denied = new Error("operator authority ended during thinking catalog loading");
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "transcript-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      signal: lifetime.signal,
    });
    vi.mocked(loadProviderScopedThinkingCatalog)
      .mockClear()
      .mockImplementation(async () => {
        lifetime.abort(denied);
        return [];
      });

    await expect(
      fixture.select({
        opts: { message: "Select thinking level", operatorAuthority },
        requestedThinkLevel: "low",
      }),
    ).rejects.toBe(denied);

    expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledTimes(1);
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });
});
