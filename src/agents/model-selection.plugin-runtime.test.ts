// Covers plugin-owned model id normalization through selection surfaces.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

const normalizeProviderModelIdWithPluginMock = vi.fn();

function normalizeLegacyFixtureModel({
  provider,
  context,
}: {
  provider: string;
  context: { modelId?: string };
}) {
  return provider === "custom-provider" && context.modelId === "custom-legacy-model"
    ? "custom-modern-model"
    : undefined;
}

const emptyPluginMetadataSnapshot = {
  configFingerprint: "model-selection-plugin-runtime-test-empty-plugin-metadata",
  ...createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "google-model-normalizer",
        modelIdNormalization: {
          providers: {
            google: {
              aliases: {
                "gemini-3.1-pro": "gemini-3.1-pro-preview",
              },
            },
          },
        },
      },
    ],
  }),
};
const getCurrentPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const loadPreparedModelCatalogSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("./model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: () => [],
  loadProviderScopedThinkingCatalog: async () => [],
  readPreparedModelCatalog: async () => [],
  loadPreparedModelCatalogSnapshot: loadPreparedModelCatalogSnapshotMock,
}));

let createModelSelectionStateForTest: typeof import("../auto-reply/reply/model-selection.js").createModelSelectionState;
let resolveSessionModelRef: typeof import("./session-model-ref.js").resolveSessionModelRef;

describe("model-selection plugin runtime normalization", () => {
  beforeAll(async () => {
    ({ createModelSelectionState: createModelSelectionStateForTest } =
      await import("../auto-reply/reply/model-selection.js"));
    ({ resolveSessionModelRef } = await import("./session-model-ref.js"));
  });

  beforeEach(() => {
    normalizeProviderModelIdWithPluginMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(emptyPluginMetadataSnapshot);
    loadPreparedModelCatalogSnapshotMock.mockReset();
    loadPreparedModelCatalogSnapshotMock.mockResolvedValue({ entries: [], authoritative: true });
  });

  it("delegates provider-owned model id normalization to plugin runtime hooks", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const { parseModelRef } = await import("./model-selection.js");

    expect(parseModelRef("custom-legacy-model", "custom-provider")).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledWith({
      provider: "custom-provider",
      context: {
        provider: "custom-provider",
        modelId: "custom-legacy-model",
      },
    });
  });

  it("keeps static normalization while skipping plugin runtime hooks when disabled", async () => {
    const { parseModelRef } = await import("./model-selection.js");

    expect(
      parseModelRef("gemini-3.1-pro", "google", {
        allowPluginNormalization: false,
      }),
    ).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "normalizes bare defaults with configured provider rows=%s",
    async (hasRows) => {
      normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

      const { resolveConfiguredModelRef } = await import("./model-selection.js");

      expect(
        resolveConfiguredModelRef({
          cfg: {
            agents: {
              defaults: {
                model: { primary: "custom-legacy-model" },
                models: hasRows ? { "custom-provider/custom-legacy-model": {} } : {},
              },
            },
          },
          defaultProvider: hasRows ? "openai" : "custom-provider",
          defaultModel: "gpt-5.5",
        }),
      ).toEqual({
        provider: "custom-provider",
        model: "custom-modern-model",
      });
    },
  );

  it.each([
    ["keeps model visibility policy construction off plugin runtime hooks by default", undefined],
    [
      "propagates explicit plugin runtime normalization opt-in through model visibility policy",
      true,
    ],
  ] as const)("%s", async (_name, allowPluginNormalization) => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);
    const { createModelVisibilityPolicy } = await import("./model-visibility-policy.js");
    const policy = createModelVisibilityPolicy({
      cfg: {
        agents: { defaults: { models: { "custom-provider/custom-legacy-model": {} } } },
      },
      catalog: [],
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
      ...(allowPluginNormalization ? { allowPluginNormalization } : {}),
    });

    if (allowPluginNormalization) {
      expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(true);
      expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalled();
    } else {
      expect(policy.allowedKeys.has("custom-provider/custom-legacy-model")).toBe(true);
      expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(false);
      expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
    }
  });

  it("normalizes an unrestricted reply default before selecting it", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);
    const cfg = {
      agents: {
        defaults: { model: "custom-provider/custom-legacy-model", modelPolicy: { allow: [] } },
      },
    };
    const { resolveDefaultModel } =
      await import("../auto-reply/reply/directive-handling.defaults.js");
    const { defaultProvider, defaultModel } = resolveDefaultModel({ cfg });
    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    expect({ provider: state.provider, model: state.model }).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
  });

  it("resolves bare reply defaults from the captured manifest once", async () => {
    const cfg = { agents: { defaults: { model: "entry" } } };
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "fixture",
          modelIdNormalization: {
            providers: { openai: { aliases: { entry: "middle", middle: "final" } } },
          },
        },
      ],
    });
    getCurrentPluginMetadataSnapshotMock.mockImplementation((params) =>
      params?.config === cfg ? snapshot : undefined,
    );
    const { resolveDefaultModel } =
      await import("../auto-reply/reply/directive-handling.defaults.js");
    const { defaultProvider, defaultModel } = resolveDefaultModel({ cfg });
    expect(defaultModel).toBe("middle");
    const selection = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });
    expect(selection).toMatchObject({ provider: "openai", model: "middle" });
  });

  it("keeps plugin-normalized stored overrides allowed in auto-reply runtime selection", async () => {
    // Stored session overrides are runtime inputs, so provider-owned
    // normalization keeps old persisted ids usable without resetting them.
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const cfg = {
      agents: {
        defaults: {
          models: {
            "custom-provider/custom-legacy-model": {},
          },
        },
      },
    };
    const sessionKey = "agent:main:discord:channel:c1";
    const sessionEntry = {
      sessionId: sessionKey,
      updatedAt: 1,
      providerOverride: "custom-provider",
      modelOverride: "custom-legacy-model",
    };
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
      provider: "custom-provider",
      model: "custom-legacy-model",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("custom-provider");
    expect(state.model).toBe("custom-modern-model");
    expect(state.resetModelOverride).toBe(false);
  });

  it.each(["session", "parent"])(
    "resolves raw %s pins with captured manifest metadata",
    async (source) => {
      const cfg = {
        agents: {
          defaults: {
            model: "snapshot-fixture/default",
            modelPolicy: { allow: ["snapshot-fixture/stored-modern"] },
          },
        },
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "snapshot-fixture",
            modelIdNormalization: {
              providers: {
                "snapshot-fixture": { aliases: { "stored-legacy": "stored-modern" } },
              },
            },
          },
        ],
      });
      getCurrentPluginMetadataSnapshotMock.mockImplementation((params) =>
        params?.config === cfg ? metadataSnapshot : undefined,
      );
      const sessionKey = "agent:main:snapshot-child";
      const parentSessionKey = "agent:main:snapshot-parent";
      const storedEntry = {
        sessionId: "snapshot-pin",
        updatedAt: 1,
        providerOverride: "snapshot-fixture",
        modelOverride: "stored-legacy",
      };
      const sessionEntry =
        source === "session" ? storedEntry : { sessionId: sessionKey, updatedAt: 1 };
      const state = await createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents.defaults,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry, [parentSessionKey]: storedEntry },
        sessionKey,
        parentSessionKey: source === "parent" ? parentSessionKey : undefined,
        defaultProvider: "snapshot-fixture",
        defaultModel: "default",
        provider: "snapshot-fixture",
        model: "default",
        hasModelDirective: false,
      });

      expect(state).toMatchObject({
        provider: "snapshot-fixture",
        model: "stored-modern",
        resetModelOverride: false,
      });
      expect(storedEntry.modelOverride).toBe("stored-legacy");
    },
  );

  it("keeps resolved persisted overrides off plugin runtime hooks", () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue("incorrectly-renormalized-model");

    expect(
      resolveSessionModelRef(
        {},
        {
          providerOverride: "custom-provider",
          modelOverride: "custom-modern-model",
          modelOverrideRouteResolution: "resolved",
        },
        "main",
      ),
    ).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("normalizes raw persisted overrides through plugin runtime hooks", () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    expect(
      resolveSessionModelRef(
        {},
        {
          providerOverride: "custom-provider",
          modelOverride: "custom-legacy-model",
        },
        "main",
      ),
    ).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledOnce();
  });

  it("reuses one lifecycle metadata snapshot across auto-reply model normalization", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    const configuredRefs = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`custom-provider/model-${index}`, {}]),
    );
    const cfg = {
      agents: {
        defaults: {
          modelPolicy: { allow: Object.keys(configuredRefs) },
          models: configuredRefs,
        },
      },
    };

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      defaultProvider: "custom-provider",
      defaultModel: "model-0",
      provider: "custom-provider",
      model: "model-0",
      hasModelDirective: false,
    });

    expect(state.allowedModelCatalog).toHaveLength(20);
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    });
  });

  it("keeps concurrent model-policy runs isolated while sharing metadata", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    let signalFirstCatalogLoad: (() => void) | undefined;
    let releaseFirstCatalogLoad: (() => void) | undefined;
    const firstCatalogLoadStarted = new Promise<void>((resolve) => {
      signalFirstCatalogLoad = resolve;
    });
    const firstCatalogLoadRelease = new Promise<void>((resolve) => {
      releaseFirstCatalogLoad = resolve;
    });
    loadPreparedModelCatalogSnapshotMock
      .mockImplementationOnce(async () => {
        signalFirstCatalogLoad?.();
        await firstCatalogLoadRelease;
        return { entries: [], authoritative: true };
      })
      .mockResolvedValue({ entries: [], authoritative: true });
    const createConfig = (model: string) => ({
      agents: {
        defaults: {
          modelPolicy: { allow: [`custom-provider/${model}`] },
          models: { [`custom-provider/${model}`]: {} },
        },
      },
    });
    const firstConfig = createConfig("first");
    const secondConfig = createConfig("second");

    const select = (cfg: ReturnType<typeof createConfig>, model: string) =>
      createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents.defaults,
        defaultProvider: "custom-provider",
        defaultModel: model,
        provider: "custom-provider",
        model,
        hasModelDirective: true,
      });

    const firstPromise = select(firstConfig, "first");
    await firstCatalogLoadStarted;
    const secondPromise = select(secondConfig, "second");
    await vi.waitFor(() => expect(loadPreparedModelCatalogSnapshotMock).toHaveBeenCalledTimes(2));
    releaseFirstCatalogLoad?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect([...first.allowedModelKeys]).toContain("custom-provider/first");
    expect([...first.allowedModelKeys]).not.toContain("custom-provider/second");
    expect([...second.allowedModelKeys]).toContain("custom-provider/second");
    expect([...second.allowedModelKeys]).not.toContain("custom-provider/first");
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledTimes(2);
    expect(getCurrentPluginMetadataSnapshotMock.mock.calls).toEqual([
      [{ config: firstConfig, allowWorkspaceScopedSnapshot: true }],
      [{ config: secondConfig, allowWorkspaceScopedSnapshot: true }],
    ]);
  });

  it("preserves runtime discovery fallback across configured, stored, and fallback refs", async () => {
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    const aliases = new Map([
      ["configured-legacy", "configured-modern"],
      ["stored-legacy", "stored-modern"],
      ["fallback-legacy", "fallback-modern"],
    ]);
    normalizeProviderModelIdWithPluginMock.mockImplementation(({ context }) => {
      const modelId = (context as { modelId?: string }).modelId ?? "";
      return aliases.get(modelId);
    });
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "custom-provider/configured-legacy",
            fallbacks: ["custom-provider/fallback-legacy"],
          },
          modelPolicy: {
            allow: ["custom-provider/configured-legacy", "custom-provider/stored-legacy"],
          },
          models: {
            "custom-provider/configured-legacy": {},
            "custom-provider/stored-legacy": {},
          },
        },
      },
    };
    const sessionKey = "agent:main:discord:channel:c1";
    const sessionEntry = {
      sessionId: sessionKey,
      updatedAt: 1,
      providerOverride: "custom-provider",
      modelOverride: "stored-legacy",
    };

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      defaultProvider: "custom-provider",
      defaultModel: "configured-legacy",
      provider: "custom-provider",
      model: "configured-legacy",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("custom-provider");
    expect(state.model).toBe("stored-modern");
    expect([...state.allowedModelKeys]).toEqual(
      expect.arrayContaining([
        "custom-provider/configured-modern",
        "custom-provider/stored-modern",
      ]),
    );
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    });
    expect(
      normalizeProviderModelIdWithPluginMock.mock.calls.map(
        ([call]) => (call as { context?: { modelId?: string } }).context?.modelId,
      ),
    ).toEqual(expect.arrayContaining(["configured-legacy", "stored-legacy", "fallback-legacy"]));
  });
});
