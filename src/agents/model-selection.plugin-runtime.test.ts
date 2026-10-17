import { beforeEach, expect, it, vi } from "vitest";
import { createModelSelectionState as selectState } from "../auto-reply/reply/model-selection.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveSessionModelRef } from "./session-model-ref.js";

const customProvider = "custom-provider";
const legacy = "custom-legacy-model";
const modern = "custom-modern-model";
const legacyRef = `${customProvider}/${legacy}`;
const modernRef = `${customProvider}/${modern}`;
const emptyPluginMetadataSnapshot = createPluginMetadataSnapshotFixture();
const { normalizeModelId, metadataSnapshot, catalogSnapshot } = vi.hoisted(() => ({
  normalizeModelId: vi.fn(),
  metadataSnapshot: vi.fn(),
  catalogSnapshot: vi.fn(),
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeModelId,
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: metadataSnapshot,
}));

vi.mock("./model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: () => [],
  loadProviderScopedThinkingCatalog: async () => [],
  readPreparedModelCatalog: async () => [],
  loadPreparedModelCatalogSnapshot: catalogSnapshot,
}));

type SelectionParams = Parameters<typeof selectState>[0];

function defaultsConfig(defaults: AgentDefaultsConfig): OpenClawConfig {
  return { agents: { defaults } };
}

function captureAliases(cfg: OpenClawConfig, provider: string, aliases: Record<string, string>) {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: provider, modelIdNormalization: { providers: { [provider]: { aliases } } } }],
  });
  metadataSnapshot.mockImplementation((params) => (params?.config === cfg ? snapshot : undefined));
}

function pin(provider: string, model: string, sessionId: string) {
  return { sessionId, updatedAt: 1, providerOverride: provider, modelOverride: model };
}

function selectModel(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  overrides: Pick<
    Partial<SelectionParams>,
    "sessionEntry" | "sessionStore" | "sessionKey" | "parentSessionKey" | "hasModelDirective"
  > = {},
) {
  return selectState({
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

beforeEach(() => {
  normalizeModelId.mockReset();
  metadataSnapshot.mockReset().mockReturnValue(emptyPluginMetadataSnapshot);
  catalogSnapshot.mockReset().mockResolvedValue({ entries: [], authoritative: true });
});

it("keeps model visibility policy construction off plugin runtime hooks by default", async () => {
  normalizeModelId.mockImplementation(
    ({ provider: owner, context }: { provider: string; context: { modelId?: string } }) =>
      owner === customProvider && context.modelId === legacy ? modern : undefined,
  );
  const { createModelVisibilityPolicy } = await import("./model-visibility-policy.js");
  const policy = createModelVisibilityPolicy({
    cfg: defaultsConfig({ models: { [legacyRef]: {} } }),
    catalog: [],
    defaultProvider: customProvider,
    defaultModel: legacy,
  });

  expect(policy.allowedKeys.has(legacyRef)).toBe(true);
  expect(policy.allowedKeys.has(modernRef)).toBe(false);
  expect(normalizeModelId).not.toHaveBeenCalled();
});

it("resolves bare reply defaults from the captured manifest once", async () => {
  const cfg = defaultsConfig({ model: "entry" });
  captureAliases(cfg, "openai", { entry: "middle", middle: "final" });
  const { resolveDefaultModel } =
    await import("../auto-reply/reply/directive-handling.defaults.js");
  const { defaultProvider, defaultModel } = resolveDefaultModel({ cfg });
  expect(defaultModel).toBe("middle");
  const selection = await selectModel(cfg, defaultProvider, defaultModel);
  expect(selection).toMatchObject({ provider: "openai", model: "middle" });
});

it.each(["session", "parent"])("normalizes captured raw %s pins", async (source) => {
  const cfg = defaultsConfig({
    model: "snapshot-fixture/default",
    modelPolicy: { allow: ["snapshot-fixture/stored-modern"] },
  });
  captureAliases(cfg, "snapshot-fixture", { "stored-legacy": "stored-modern" });
  const sessionKey = "agent:main:snapshot-child";
  const parentSessionKey = "agent:main:snapshot-parent";
  const storedEntry = pin("snapshot-fixture", "stored-legacy", "snapshot-pin");
  const sessionEntry = source === "session" ? storedEntry : { sessionId: sessionKey, updatedAt: 1 };
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
});

it("keeps resolved persisted overrides off plugin runtime hooks", () => {
  normalizeModelId.mockReturnValue("incorrectly-renormalized-model");

  expect(
    resolveSessionModelRef(
      {},
      {
        providerOverride: customProvider,
        modelOverride: modern,
        modelOverrideRouteResolution: "resolved",
      },
      "main",
    ),
  ).toEqual({ provider: customProvider, model: modern });
  expect(normalizeModelId).not.toHaveBeenCalled();
});

it("keeps concurrent model-policy runs isolated while sharing metadata", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  catalogSnapshot.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return { entries: [], authoritative: true };
  });
  const createConfig = (model: string) =>
    defaultsConfig({
      modelPolicy: { allow: [`custom-provider/${model}`] },
      models: { [`custom-provider/${model}`]: {} },
    });
  const firstConfig = createConfig("first");
  const secondConfig = createConfig("second");

  const select = (cfg: ReturnType<typeof createConfig>, model: string) =>
    selectModel(cfg, customProvider, model, { hasModelDirective: true });

  const firstPromise = select(firstConfig, "first");
  await started.promise;
  const second = await select(secondConfig, "second");
  expect(catalogSnapshot).toHaveBeenCalledTimes(2);
  release.resolve();
  const first = await firstPromise;

  expect([...first.allowedModelKeys]).toContain("custom-provider/first");
  expect([...first.allowedModelKeys]).not.toContain("custom-provider/second");
  expect([...second.allowedModelKeys]).toContain("custom-provider/second");
  expect([...second.allowedModelKeys]).not.toContain("custom-provider/first");
  expect(metadataSnapshot.mock.calls).toEqual([
    [{ config: firstConfig, allowWorkspaceScopedSnapshot: true }],
    [{ config: secondConfig, allowWorkspaceScopedSnapshot: true }],
  ]);
});

it("preserves runtime discovery fallback across configured, stored, and fallback refs", async () => {
  metadataSnapshot.mockReturnValue(undefined);
  const aliases = new Map([
    ["configured-legacy", "configured-modern"],
    ["stored-legacy", "stored-modern"],
    ["fallback-legacy", "fallback-modern"],
  ]);
  normalizeModelId.mockImplementation(({ context }: { context: { modelId?: string } }) =>
    aliases.get(context.modelId ?? ""),
  );
  const cfg = defaultsConfig({
    model: {
      primary: "custom-provider/configured-legacy",
      fallbacks: ["custom-provider/fallback-legacy"],
    },
    modelPolicy: {
      allow: ["custom-provider/configured-legacy", "custom-provider/stored-legacy"],
    },
    models: { "custom-provider/configured-legacy": {}, "custom-provider/stored-legacy": {} },
  });
  const sessionKey = "agent:main:discord:channel:c1";
  const sessionEntry = pin(customProvider, "stored-legacy", sessionKey);

  const state = await selectModel(cfg, customProvider, "configured-legacy", {
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
  });

  expect(state).toMatchObject({ provider: customProvider, model: "stored-modern" });
  expect([...state.allowedModelKeys]).toEqual(
    expect.arrayContaining(["custom-provider/configured-modern", "custom-provider/stored-modern"]),
  );
  expect(metadataSnapshot).toHaveBeenCalledWith({
    config: cfg,
    allowWorkspaceScopedSnapshot: true,
  });
  expect(
    normalizeModelId.mock.calls.map(
      ([call]) => (call as { context?: { modelId?: string } }).context?.modelId,
    ),
  ).toEqual(expect.arrayContaining(["configured-legacy", "stored-legacy", "fallback-legacy"]));
});
