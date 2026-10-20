// Covers plugin-owned model id normalization through selection surfaces.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
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

const emptyPluginMetadataSnapshot = createPluginMetadataSnapshotFixture();
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

function aliasSnapshot(provider: string, aliases: Record<string, string>) {
  return createPluginMetadataSnapshotFixture({
    plugins: [{ id: provider, modelIdNormalization: { providers: { [provider]: { aliases } } } }],
  });
}

function selectModel(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  overrides: Partial<
    Pick<
      Parameters<typeof createModelSelectionStateForTest>[0],
      "sessionEntry" | "sessionStore" | "sessionKey" | "parentSessionKey" | "hasModelDirective"
    >
  > = {},
) {
  return createModelSelectionStateForTest({
    cfg,
    agentCfg: cfg.agents?.defaults,
    agentId: "main",
    defaultProvider: provider,
    defaultModel: model,
    provider,
    model,
    hasModelDirective: false,
    ...overrides,
  });
}

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

  it("keeps model visibility policy construction off plugin runtime hooks by default", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);
    const { createModelVisibilityPolicy } = await import("./model-visibility-policy.js");
    const policy = createModelVisibilityPolicy({
      cfg: { agents: { defaults: { models: { "custom-provider/custom-legacy-model": {} } } } },
      catalog: [],
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
    });

    expect(policy.allowedKeys.has("custom-provider/custom-legacy-model")).toBe(true);
    expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(false);
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("resolves bare reply defaults from the captured manifest once", async () => {
    const cfg = { agents: { defaults: { model: "entry" } } };
    const snapshot = aliasSnapshot("openai", { entry: "middle", middle: "final" });
    getCurrentPluginMetadataSnapshotMock.mockImplementation((params) =>
      params?.config === cfg ? snapshot : undefined,
    );
    const { resolveDefaultModel } =
      await import("../auto-reply/reply/directive-handling.defaults.js");
    const { defaultProvider, defaultModel } = resolveDefaultModel({ cfg });
    expect(defaultModel).toBe("middle");
    const selection = await selectModel(cfg, defaultProvider, defaultModel);
    expect(selection).toMatchObject({ provider: "openai", model: "middle" });
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
      const metadataSnapshot = aliasSnapshot("snapshot-fixture", {
        "stored-legacy": "stored-modern",
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
      const state = await selectModel(cfg, "snapshot-fixture", "default", {
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry, [parentSessionKey]: storedEntry },
        sessionKey,
        parentSessionKey: source === "parent" ? parentSessionKey : undefined,
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
    ).toEqual({ provider: "custom-provider", model: "custom-modern-model" });
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
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
      selectModel(cfg, "custom-provider", model, { hasModelDirective: true });

    const firstPromise = select(firstConfig, "first");
    await firstCatalogLoadStarted;
    const second = await select(secondConfig, "second");
    expect(loadPreparedModelCatalogSnapshotMock).toHaveBeenCalledTimes(2);
    releaseFirstCatalogLoad?.();
    const first = await firstPromise;

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

    const state = await selectModel(cfg, "custom-provider", "configured-legacy", {
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
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
