import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Covers plugin-owned model id normalization through selection surfaces.
import type { ReplyModelSelection } from "../auto-reply/reply/model-runtime-normalization.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";

// These fixtures enter the owner with static policy already applied; route resolution
// remains separate so runtime hooks are still exercised by ordinary selections.
function preparedSelection(
  provider: string,
  model: string,
  routeResolution: ReplyModelSelection["routeResolution"] = "raw",
): ReplyModelSelection {
  return { ref: { provider, model }, normalization: "applied", routeResolution };
}

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
            "custom-provider": { aliases: { middle: "final", final: "replayed" } },
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
  loadPreparedModelCatalog: async () => [],
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

  it("keeps provider plugin normalization when inferring provider for bare defaults", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const { resolveConfiguredModelRef } = await import("./model-selection.js");

    expect(
      resolveConfiguredModelRef({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "custom-legacy-model" },
              models: {
                "custom-provider/custom-legacy-model": {},
              },
            },
          },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
      }),
    ).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
  });

  it.each([
    ["keeps model visibility policy construction off plugin runtime hooks by default", undefined],
    [
      "propagates explicit plugin runtime normalization opt-in through model visibility policy",
      true,
    ],
  ] as const)("%s", async (_name, allowPluginNormalization) => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(
      (params: Parameters<typeof normalizeLegacyFixtureModel>[0]) =>
        params.context.modelId === "fallback-legacy"
          ? "fallback-modern"
          : normalizeLegacyFixtureModel(params),
    );
    const { createModelVisibilityPolicy } = await import("./model-visibility-policy.js");
    const policy = createModelVisibilityPolicy({
      cfg: {
        agents: {
          defaults: {
            model: { fallbacks: ["fallback-legacy"] },
            models: { "custom-provider/custom-legacy-model": {} },
          },
        },
      },
      catalog: [],
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
      ...(allowPluginNormalization ? { allowPluginNormalization } : {}),
    });

    if (allowPluginNormalization) {
      expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(true);
      expect(policy.retainedKeys).toContain("custom-provider/fallback-modern");
      expect(
        normalizeProviderModelIdWithPluginMock.mock.calls
          .map(([call]) => call.context.modelId)
          .filter((model) => model === "fallback-legacy"),
      ).toEqual(["fallback-legacy"]);
    } else {
      expect(policy.allowedKeys.has("custom-provider/custom-legacy-model")).toBe(true);
      expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(false);
      expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
      expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])(
    "completes the real reply default once (configured fallback=%s)",
    async (configuredFallback) => {
      getCurrentPluginMetadataSnapshotMock.mockReturnValue(
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "reply-normalizer",
              modelIdNormalization: {
                providers: {
                  "custom-provider": {
                    aliases: { "custom-legacy-model": "middle", middle: "final" },
                  },
                },
              },
            },
          ],
        }),
      );
      normalizeProviderModelIdWithPluginMock.mockImplementation(({ context }) =>
        context.modelId === "middle"
          ? "custom-modern-model"
          : context.modelId === "custom-modern-model"
            ? "replayed"
            : undefined,
      );
      const cfg: OpenClawConfig = configuredFallback
        ? {
            models: {
              providers: {
                "custom-provider": {
                  baseUrl: "https://fixture.invalid/v1",
                  models: [
                    {
                      id: "custom-legacy-model",
                      name: "Custom",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      maxTokens: 1024,
                    },
                  ],
                },
              },
            },
          }
        : { agents: { defaults: { model: { primary: "custom-provider/custom-legacy-model" } } } };
      const { resolveDefaultModel } =
        await import("../auto-reply/reply/directive-handling.defaults.js");
      const { defaultSelection } = resolveDefaultModel({ cfg });
      const state = await createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents?.defaults,
        defaultSelection,
        selection: defaultSelection,
        hasModelDirective: false,
      });
      expect({ provider: state.provider, model: state.model }).toEqual({
        provider: "custom-provider",
        model: configuredFallback ? "middle" : "custom-modern-model",
      });
      expect(
        normalizeProviderModelIdWithPluginMock.mock.calls
          .filter(([params]) => params.provider === "custom-provider")
          .map(([params]) => params.context.modelId),
      ).toEqual(configuredFallback ? [] : ["middle"]);
    },
  );

  it("runtime-normalizes a selected catalog fallback before returning it", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(({ context }) =>
      context.modelId === "custom-legacy-model" ? "custom-modern-model" : undefined,
    );
    loadPreparedModelCatalogSnapshotMock.mockResolvedValue({
      entries: [{ provider: "custom-provider", id: "custom-legacy-model", name: "Custom" }],
      authoritative: true,
    });
    const cfg = {
      agents: { defaults: { modelPolicy: { allow: ["custom-provider/*"] } } },
    };
    const defaultSelection = preparedSelection("other", "disallowed");
    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      defaultSelection,
      selection: defaultSelection,
      hasModelDirective: false,
    });
    expect({ provider: state.provider, model: state.model }).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
  });

  it.each([false, true])(
    "does not replay static policy for a prepared selection (fallback=%s)",
    async (fallback) => {
      const { normalizeProviderModelIdWithManifest } =
        await import("../plugins/manifest-model-id-normalization.js");
      normalizeProviderModelIdWithPluginMock.mockImplementation(
        normalizeProviderModelIdWithManifest,
      );
      const cfg = { agents: { defaults: { modelPolicy: { allow: ["custom-provider/*"] } } } };
      loadPreparedModelCatalogSnapshotMock.mockResolvedValue({
        entries: [{ provider: "custom-provider", id: "middle", name: "Custom" }],
        authoritative: true,
      });
      const defaultSelection = preparedSelection("other", "disallowed");
      const state = await createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents.defaults,
        defaultSelection,
        selection: fallback ? defaultSelection : preparedSelection("custom-provider", "middle"),
        hasModelDirective: false,
      });
      expect({ provider: state.provider, model: state.model }).toEqual({
        provider: "custom-provider",
        model: "middle",
      });
    },
  );

  it.each(["custom-provider/model", "middle"])(
    "preserves the resolved reply selection %s",
    async (model) => {
      normalizeProviderModelIdWithPluginMock.mockReturnValue("replayed");
      const sessionEntry = {
        sessionId: "resolved-reply",
        updatedAt: 1,
        providerOverride: "custom-provider",
        modelOverride: model,
        modelOverrideRouteResolution: "resolved" as const,
      };
      const defaultSelection = preparedSelection("other", "default");
      const state = await createModelSelectionStateForTest({
        cfg: {},
        agentCfg: undefined,
        sessionEntry,
        defaultSelection,
        selection: preparedSelection("custom-provider", model, "resolved"),
        hasModelDirective: false,
      });
      expect({ provider: state.provider, model: state.model }).toEqual({
        provider: "custom-provider",
        model,
      });
      expect(
        normalizeProviderModelIdWithPluginMock.mock.calls.some(
          ([params]) => params.context.modelId === model,
        ),
      ).toBe(false);
    },
  );

  it("keeps plugin-normalized stored overrides allowed in auto-reply runtime selection", async () => {
    // Stored session overrides are runtime inputs, so provider-owned
    // normalization keeps old persisted ids usable without resetting them.
    normalizeProviderModelIdWithPluginMock.mockImplementation((params) =>
      params.context.modelId === "custom-modern-model"
        ? "replayed-model"
        : normalizeLegacyFixtureModel(params),
    );

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

    const defaultSelection = preparedSelection("custom-provider", "custom-legacy-model");
    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultSelection,
      selection: defaultSelection,
      hasModelDirective: false,
    });

    expect(state.provider).toBe("custom-provider");
    expect(state.model).toBe("custom-modern-model");
    expect(state.resetModelOverride).toBe(false);
  });

  it.each([
    { model: "model", thinking: "low", contextWindow: 64000 },
    { model: "custom/model", thinking: "high", contextWindow: 128000 },
  ])(
    "keeps reply settings and prepared capabilities owned by $model",
    async ({ model, thinking, contextWindow }) => {
      const entries = [
        { provider: "custom", id: "model", name: "Plain", contextWindow: 64000, reasoning: true },
        {
          provider: "custom",
          id: "custom/model",
          name: "Nested",
          contextWindow: 128000,
          reasoning: true,
        },
      ];
      const cfg = {
        models: {
          providers: {
            custom: {
              baseUrl: "https://custom.example/v1",
              api: "openai-completions" as const,
              models: entries.map((entry) => ({
                ...entry,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 1024,
              })),
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "custom/model": { params: { thinking: "low" } },
              "custom/custom/model": { params: { thinking: "high" } },
            },
          },
        },
      };
      const defaultSelection = preparedSelection("custom", "model");
      const state = await createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents.defaults,
        defaultSelection,
        selection: preparedSelection("custom", model, "resolved"),
        hasModelDirective: false,
        preparedModelCatalog: { entries, routeVariants: entries },
      });
      expect(state.modelContextWindow).toBe(contextWindow);
      await expect(state.resolveDefaultThinkingLevel()).resolves.toBe(thinking);
      await expect(
        state.resolveDefaultThinkingLevel({
          provider: "custom",
          model: model === "model" ? "custom/model" : "model",
        }),
      ).resolves.toBe(thinking === "low" ? "high" : "low");
    },
  );

  it.each(["custom-modern-model", "custom-provider/model", "middle"])(
    "preserves resolved persisted identity %s without another normalization pass",
    (model) => {
      normalizeProviderModelIdWithPluginMock.mockReturnValue("incorrectly-renormalized-model");

      expect(
        resolveSessionModelRef(
          {},
          {
            providerOverride: "custom-provider",
            modelOverride: model,
            modelOverrideRouteResolution: "resolved",
          },
          "main",
        ),
      ).toEqual({
        provider: "custom-provider",
        model,
      });
      expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
    },
  );

  it.each(["raw", "resolved"] as const)(
    "completes only a runtime-pending primary after stale-pin reset (%s)",
    async (primaryModelRouteResolution) => {
      normalizeProviderModelIdWithPluginMock.mockImplementation(({ context }) =>
        context.modelId === "custom-legacy-model"
          ? "custom-modern-model"
          : context.modelId === "custom-modern-model"
            ? "replayed"
            : undefined,
      );
      const sessionEntry = {
        sessionId: "stale-primary",
        updatedAt: 1,
        providerOverride: "custom-provider",
        modelOverride: "fallback",
        modelOverrideSource: "auto" as const,
        modelOverrideRouteResolution: "resolved" as const,
        modelOverrideFallbackOriginProvider: "custom-provider",
        modelOverrideFallbackOriginModel: "previous-primary",
      };
      const defaultSelection = preparedSelection("custom-provider", "custom-legacy-model");
      const state = await createModelSelectionStateForTest({
        cfg: {},
        agentCfg: undefined,
        sessionEntry,
        sessionStore: { "agent:main:stale-primary": sessionEntry },
        sessionKey: "agent:main:stale-primary",
        defaultSelection,
        primarySelection:
          primaryModelRouteResolution === "raw"
            ? defaultSelection
            : preparedSelection("custom-provider", "custom-modern-model", "resolved"),
        selection: preparedSelection("custom-provider", "fallback", "resolved"),
        hasModelDirective: false,
        isHeartbeat: true,
      });
      expect({ model: state.model, reset: state.resetModelOverride }).toEqual({
        model: "custom-modern-model",
        reset: true,
      });
    },
  );

  it("preserves legacy fallback identity through the existing resolved provenance rule", () => {
    expect(
      resolveSessionModelRef(
        {},
        {
          sessionId: "legacy-fallback",
          updatedAt: 1,
          providerOverride: "custom-provider",
          modelOverride: "middle",
          modelOverrideFallbackOriginProvider: "custom-provider",
          modelOverrideFallbackOriginModel: "legacy",
        },
        "main",
      ),
    ).toEqual({ provider: "custom-provider", model: "middle" });
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

    const defaultSelection = preparedSelection("custom-provider", "model-0");
    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      defaultSelection,
      selection: defaultSelection,
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
    const firstCatalogLoadStarted = createDeferredCore();
    const firstCatalogLoadRelease = createDeferredCore();
    loadPreparedModelCatalogSnapshotMock
      .mockImplementationOnce(async () => {
        firstCatalogLoadStarted.resolve();
        await firstCatalogLoadRelease.promise;
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

    const select = (cfg: ReturnType<typeof createConfig>, model: string) => {
      const defaultSelection = preparedSelection("custom-provider", model);
      return createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents.defaults,
        defaultSelection,
        selection: defaultSelection,
        hasModelDirective: true,
      });
    };

    const firstPromise = select(firstConfig, "first");
    await firstCatalogLoadStarted.promise;
    const secondPromise = select(secondConfig, "second");
    await vi.waitFor(() => expect(loadPreparedModelCatalogSnapshotMock).toHaveBeenCalledTimes(2));
    firstCatalogLoadRelease.resolve();
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

  it("preserves runtime discovery for configured and stored refs without preparing fallbacks", async () => {
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

    const defaultSelection = preparedSelection("custom-provider", "configured-legacy");
    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      defaultSelection,
      selection: defaultSelection,
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
    ).toEqual(expect.arrayContaining(["configured-legacy", "stored-legacy"]));
    expect(
      normalizeProviderModelIdWithPluginMock.mock.calls.map(([call]) => call.context.modelId),
    ).not.toContain("fallback-legacy");
  });

  it.each([false, true])(
    "normalizes manifest aliases before provider hooks (prepared=%s)",
    async (prepared) => {
      normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
      const preparedPlugins = [
        {
          id: "custom-model-normalizer",
          modelIdNormalization: {
            providers: {
              custom: {
                aliases: { latest: "manifest-model", "manifest-model": "reapplied-model" },
              },
            },
          },
        },
      ];
      getCurrentPluginMetadataSnapshotMock.mockReturnValue(
        createPluginMetadataSnapshotFixture({ plugins: preparedPlugins }),
      );
      const { resolveConfiguredModelRef } = await import("./model-selection.js");
      const resolve = () =>
        resolveConfiguredModelRef({
          cfg: { agents: { defaults: { model: "custom/latest" } } },
          defaultProvider: "custom",
          defaultModel: "default",
          manifestPlugins: prepared ? preparedPlugins : undefined,
        });
      expect(resolve()).toEqual({ provider: "custom", model: "manifest-model" });
      normalizeProviderModelIdWithPluginMock.mockImplementation(
        ({ context }: { context: { modelId: string } }) => `runtime/${context.modelId}`,
      );
      expect(resolve()).toEqual({ provider: "custom", model: "runtime/manifest-model" });
    },
  );
});
