import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatForLog } from "../../gateway/ws-log.js";
import * as installedManifests from "../../plugins/manifest-registry-installed.js";
import { restorePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { prepareOwnedPluginLoadContext } from "../prepared-model-runtime.plugin-context.js";
import {
  createAgentRuntimeMetadataPluginIdScope as createMetadataScope,
  resolveAgentRuntimePluginLoadPlan as loadPlan,
  resolveAgentRuntimePluginSelections,
} from "./runtime-plugin-load-plan.js";
import {
  ensureSelectedAgentHarnessPlugin as ensurePlugin,
  resolveAgentHarnessRuntimeAvailability as resolveAvailability,
} from "./runtime-plugin.js";

function runtimePlan(overrides: Partial<Parameters<typeof loadPlan>[0]>) {
  return loadPlan({
    workspaceDir: "/tmp/workspace",
    metadataSnapshot: overrides.metadataSnapshot ?? createMemoryPlanMetadataSnapshot(),
    selections: [],
    ...overrides,
  });
}

function ensureHarness(overrides: Partial<Parameters<typeof ensurePlugin>[0]>) {
  return ensurePlugin({
    provider: "custom-provider",
    modelId: "custom-model",
    workspaceDir: "/tmp/workspace",
    pluginRegistry: undefined,
    ...overrides,
  });
}

function availability(overrides: Partial<Parameters<typeof resolveAvailability>[0]> = {}) {
  return resolveAvailability({
    workspaceDir: "/tmp/workspace",
    runtime: "codex",
    provider: "openai",
    payloadFailures: [],
    payloadCheckedPluginIds: [],
    selectedPluginRootDirs: new Map(),
    ...overrides,
  });
}

function metadataScope(overrides: Partial<Parameters<typeof createMetadataScope>[0]>) {
  return createMetadataScope({
    workspaceDir: "/tmp/workspace",
    config: { plugins: { slots: { memory: "none" } } },
    selections: [],
    ...overrides,
  });
}

function resolveScope(
  scope: ReturnType<typeof metadataScope>,
  plugins: ReturnType<typeof installedProviderRecord>[],
) {
  return scope.resolve({ index: { plugins } as never });
}

async function unavailable(overrides: Parameters<typeof ensureHarness>[0]) {
  const error = await ensureHarness({
    agentHarnessRuntimeOverride: "custom-harness",
    ...overrides,
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new Error("Expected unavailable harness");
  }
  return error.message;
}

function preparedRegistry(
  config: OpenClawConfig = {},
  manifestRegistry: ReturnType<typeof makeRegistry> = makeRegistry([]),
) {
  const registry = createEmptyPluginRegistry();
  prepareOwnedPluginLoadContext(
    {
      config,
      workspaceDir: "/tmp/workspace",
      loadRuntimePlugins: true,
      runtimePluginSelections: [],
    },
    {},
    registry,
    createPluginMetadataSnapshot({ config, manifestRegistry }),
  );
  return registry;
}

function harnessManifests(
  ids: string[],
  runtime = "custom-harness",
  origin: Parameters<typeof makeRegistry>[0][number]["origin"] = "config",
) {
  return makeRegistry(
    ids.map((id) => ({
      id,
      channels: [],
      origin,
      activation: { onAgentHarnesses: [runtime] },
    })),
  );
}

const mocks = vi.hoisted(() => ({
  resolveActivatableProviderOwnerPluginIds: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveManifestActivationPlan: vi.fn(),
  resolveOwningPluginIdsForProvider: vi.fn(),
}));

function installedProviderRecord(
  pluginId: string,
  options: {
    providers?: string[];
    modelSupportPrefixes?: string[];
    agentHarnesses?: string[];
  } = {},
) {
  return {
    pluginId,
    startup: { sidecar: false, memory: false, agentHarnesses: options.agentHarnesses ?? [] },
    contributions: {
      providers: options.providers ?? [],
      modelCatalogProviders: [],
      modelSupportPrefixes: options.modelSupportPrefixes ?? [],
      modelSupportPatterns: [],
      autoEnableProviderIds: [],
      channels: [],
      channelConfigs: [],
      commandAliases: [],
      contracts: {},
    },
    compat: [],
  };
}

function createMemoryPlanMetadataSnapshot() {
  const manifestRegistry = makeRegistry(
    ["memory-core", "memory-lancedb"].map((id) => ({
      id,
      channels: [],
      origin: "bundled" as const,
    })),
  );
  for (const plugin of manifestRegistry.plugins) {
    plugin.kind = "memory";
  }
  const snapshot = createPluginMetadataSnapshot({ manifestRegistry });
  snapshot.index.plugins = manifestRegistry.plugins.map((plugin) =>
    Object.assign(installedProviderRecord(plugin.id), {
      origin: plugin.origin,
      rootDir: plugin.rootDir,
      manifestPath: plugin.manifestPath,
      manifestHash: plugin.id,
      enabled: true,
      startup: { sidecar: false, memory: true, agentHarnesses: [] },
    }),
  );
  return restorePluginMetadataSnapshot(snapshot);
}

vi.mock("../../plugins/providers.js", () => ({
  resolveActivatableProviderOwnerPluginIds: mocks.resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds: mocks.resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProvider: mocks.resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForProviderRef: mocks.resolveOwningPluginIdsForProvider,
}));

vi.mock("../../plugins/activation-planner.js", () => ({
  resolveManifestActivationPlan: mocks.resolveManifestActivationPlan,
}));

describe("harness runtime plugins", () => {
  beforeEach(() => {
    mocks.resolveActivatableProviderOwnerPluginIds.mockReset().mockReturnValue([]);
    mocks.resolveBundledProviderCompatPluginIds.mockReset().mockReturnValue([]);
    mocks.resolveOwningPluginIdsForProvider.mockReset().mockReturnValue(undefined);
    mocks.resolveManifestActivationPlan.mockReset().mockReturnValue({
      entries: [{ pluginId: "codex", origin: "bundled" }],
    });
  });

  it.each([
    { name: "session pin", selection: { agentHarnessId: "codex" } },
    {
      name: "model policy",
      selection: {
        config: {
          agents: {
            defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
          },
        },
      },
    },
  ])("keeps a missing explicit Codex $name fatal with remediation", async ({ selection }) => {
    const error = await unavailable({
      provider: "openai",
      modelId: "gpt-5.5",
      ...selection,
      agentHarnessRuntimeOverride: undefined,
      pluginRegistry: preparedRegistry(),
    });
    expect(error).toContain("(reason=owner-plugin-not-activatable, ownerPluginId=codex)");
    expect(error).toContain('Owner plugin "codex" is absent from this prepared plugin generation.');
    expect(error).toContain('Run "openclaw doctor --fix"');
  });

  it.each<[NonNullable<OpenClawConfig["plugins"]>, string]>([
    [{ enabled: false }, "plugins disabled"],
    [{ allow: ["telegram"] }, "not in allowlist"],
    [{ deny: ["codex"] }, "blocked by denylist"],
    [{ entries: { codex: { enabled: false } } }, "disabled in config"],
  ])("reports %j as %s without a prepared registry context", async (plugins, expectedReason) => {
    const error = await unavailable({
      provider: "openai",
      modelId: "gpt-5.5",
      config: { plugins },
      agentHarnessRuntimeOverride: "codex",
    });
    expect(error).toContain(expectedReason);
    expect(error).not.toContain("absent from this prepared plugin generation");
  });

  it("reports a missing activatable owner as degraded beyond the displayed owner limit", async () => {
    const config = {
      plugins: { allow: ["ready-owner"], entries: { "ready-owner": { enabled: true } } },
    } satisfies OpenClawConfig;
    const pluginRegistry = preparedRegistry(
      config,
      harnessManifests(
        ["blocked-owner-0", "blocked-owner-1", "blocked-owner-2", "ready-owner"],
        "custom-harness",
        "bundled",
      ),
    );
    const error = await unavailable({ config, pluginRegistry });
    expect(error).toContain("reason=owner-plugin-degraded");
    expect(error).toContain('Owner plugin "blocked-owner-0" is not activatable');
    expect(error).toContain("ownerPluginIds=");
  });

  it.each([
    { status: "error", failurePhase: "register", error: "registration exploded" },
    { status: "loaded" },
  ] as const)("reports the prepared owner's $status before activation policy", async (record) => {
    const pluginRegistry = preparedRegistry(
      { plugins: { allow: ["telegram"] } },
      harnessManifests(["custom-owner"]),
    );
    pluginRegistry.plugins.push(createPluginRecord({ id: "custom-owner", ...record }));
    const error = await unavailable({ pluginRegistry });
    expect(error).toContain("(reason=owner-plugin-degraded, ownerPluginId=custom-owner)");
    expect(error).toContain(
      record.status === "error"
        ? 'Owner plugin "custom-owner" failed during register.'
        : 'Owner plugin "custom-owner" loaded but did not register agent harness "custom-harness".',
    );
    expect(error).not.toContain("not in allowlist");
    expect(error).toContain('Run "openclaw plugins inspect custom-owner --runtime --json"');
    expect(error).not.toContain("registration exploded");
    expect(formatForLog(error)).toContain(
      'Run "openclaw plugins inspect custom-owner --runtime --json"',
    );
  });

  it("reports an activated config owner missing from the prepared registry as degraded", async () => {
    const manifestRegistry = harnessManifests(["custom-owner"]);
    const error = await unavailable({
      pluginRegistry: preparedRegistry({}, manifestRegistry),
    });
    expect(error).toContain("(reason=owner-plugin-degraded, ownerPluginId=custom-owner)");
    expect(error).toContain("The owner plugin did not register.");
  });

  it("gives an unknown harness without owner metadata a stable reason", async () => {
    const error = await unavailable({
      agentHarnessRuntimeOverride: "unknown-harness",
    });
    expect(error).toContain("(reason=owner-plugin-not-activatable)");
    expect(error).toContain("Enable or reinstall the plugin that provides this runtime");
  });

  it("keeps the built-in OpenClaw harness independent from plugin registration", async () => {
    await expect(
      ensureHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        agentHarnessRuntimeOverride: "openclaw",
        pluginRegistry: preparedRegistry({ plugins: { enabled: false } }),
      }),
    ).resolves.toBeUndefined();
  });

  it("includes the configured picker harness in metadata and activation preparation", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.6-sol",
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" }, pickerRuntimes: ["codex"] },
          },
        },
      },
      plugins: { slots: { memory: "none" } },
    };
    const selections = [{ provider: "openai", modelId: "gpt-5.6-sol", runtime: "openclaw" }];
    const scope = metadataScope({ config, selections });
    expect(
      resolveScope(scope, [
        installedProviderRecord("openai", { providers: ["openai"] }),
        installedProviderRecord("codex", { agentHarnesses: ["codex"] }),
      ]),
    ).toEqual(["codex", "openai"]);
    const plan = runtimePlan({
      config,
      selections: resolveAgentRuntimePluginSelections(config, selections),
    });
    expect(plan.pluginIds).toContain("codex");
    expect(plan.config?.plugins?.entries?.codex).toEqual({ enabled: true });
  });

  it("scopes cold metadata to selected runtime candidates from the installed index", () => {
    const scope = createMetadataScope({
      config: { plugins: { slots: { memory: "none" } } },
      workspaceDir: "/tmp/workspace",
      selections: [
        { provider: "selected-provider", modelId: "selected-model", runtime: "openclaw" },
      ],
    });
    expect(
      scope.resolve({
        index: {
          plugins: [
            installedProviderRecord("selected-plugin", { providers: ["selected-provider"] }),
            installedProviderRecord("unrelated-plugin", {
              providers: ["unrelated-provider"],
            }),
          ],
        } as never,
      }),
    ).toEqual(["selected-plugin"]);
  });

  it("retains shorthand model owners while resolving the fallback provider", () => {
    const scope = metadataScope({
      selections: [{ provider: "fallback-provider", modelId: "magic-model" }],
      shorthandModelIds: ["magic-model"],
    });
    expect(
      resolveScope(scope, [
        installedProviderRecord("fallback-provider", { providers: ["fallback-provider"] }),
        installedProviderRecord("magic-model-owner", { modelSupportPrefixes: ["magic-"] }),
      ]),
    ).toEqual(["fallback-provider", "magic-model-owner"]);
  });

  it("keeps metadata unscoped for ambiguous indirect provider ownership", () => {
    const scope = metadataScope({
      selections: [{ provider: "provider-alias", modelId: "selected-model" }],
    });
    expect(
      resolveScope(scope, [
        installedProviderRecord("first-owner", { providers: ["provider-alias"] }),
        installedProviderRecord("second-owner", { providers: ["provider-alias"] }),
      ]),
    ).toBeUndefined();
  });

  it("includes the selected provider owner when policy selects an omitted harness", () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(["openai"]);
    mocks.resolveActivatableProviderOwnerPluginIds.mockReturnValueOnce(["openai"]);
    mocks.resolveManifestActivationPlan.mockReturnValueOnce({ entries: [] });
    const plan = runtimePlan({
      config: { plugins: { allow: ["openai"] } },
      selections: [{ provider: "openai", modelId: "gpt-5" }],
    });
    expect(plan.pluginIds).toEqual(["openai"]);
    expect(plan.config?.plugins?.entries?.openai).toEqual({ enabled: true });
  });

  it("includes and enables the context-engine owner in the prepared load plan", () => {
    const plan = runtimePlan({
      config: { plugins: { slots: { contextEngine: "custom-context-engine" } } },
      basePluginIds: [],
    });
    expect(plan.pluginIds).toEqual(["custom-context-engine"]);
    expect(plan.config?.plugins?.allow).toEqual(["custom-context-engine"]);
    expect(plan.config?.plugins?.entries?.["custom-context-engine"]).toEqual({ enabled: true });
  });

  it.each([
    [[], ["catalog-provider"], []],
    [["catalog-provider"], ["catalog-provider"], ["catalog-provider"]],
    [["catalog-provider"], ["other-provider"], []],
  ])("keeps catalog scope %j within allowlist %j", (basePluginIds, allowed, expected) => {
    const config: OpenClawConfig = {
      plugins: {
        allow: [...allowed, "memory-lancedb", "custom-context-engine", "codex"],
        slots: { memory: "memory-lancedb", contextEngine: "custom-context-engine" },
      },
    };
    const plan = runtimePlan({
      metadataSnapshot: createPluginMetadataSnapshot({
        manifestRegistry: harnessManifests(["codex"], "codex", "bundled"),
      }),
      config,
      basePluginIds,
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
      purpose: "model-catalog",
    });
    expect(plan.pluginIds).toEqual(expected);
    expect(plan.config?.plugins?.entries).toBeUndefined();
    expect(plan.config?.plugins?.slots).toEqual(config.plugins?.slots);
  });

  it.each<[OpenClawConfig["plugins"], string[]]>([
    [undefined, []],
    [{ slots: { memory: "memory-core" } }, ["memory-core"]],
    [{ entries: { "memory-core": { enabled: true } } }, ["memory-core"]],
    [{ slots: { memory: "none" } }, []],
    [{ entries: { "memory-core": { enabled: false } } }, []],
  ])("preserves config-owned memory selection for %j", (plugins, expectedPluginIds) => {
    const config = plugins ? { plugins } : {};
    const plan = runtimePlan({ config });
    expect(plan.pluginIds ?? []).toEqual(expectedPluginIds);
    expect(plan.config).toMatchObject(config);
    for (const pluginId of expectedPluginIds) {
      expect(plan.config?.plugins?.entries?.[pluginId]).toEqual({ enabled: true });
    }
  });

  it("reuses prepared memory aliases while applying current activation policy", () => {
    const config: OpenClawConfig = { plugins: { slots: { memory: "fixture-memory" } } };
    const snapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([
        { id: "fixture-memory", channels: [], providers: ["memory-alias"] },
      ]),
    });
    snapshot.index.plugins = [
      {
        ...installedProviderRecord("fixture-memory"),
        origin: "config",
        rootDir: "/fake/fixture-memory",
        manifestPath: "/fake/fixture-memory/openclaw.plugin.json",
        manifestHash: "fixture",
        enabled: true,
        enabledByDefault: true,
        startup: { sidecar: false, memory: true, agentHarnesses: [] },
      },
    ];
    const metadataSnapshot = restorePluginMetadataSnapshot(snapshot);
    const rebuildManifests = vi
      .spyOn(installedManifests, "loadPluginManifestRegistryForInstalledIndex")
      .mockReturnValue(metadataSnapshot.manifestRegistry);
    try {
      for (const enabled of [true, false, true]) {
        config.plugins!.entries = { "memory-alias": { enabled } };
        const plan = runtimePlan({
          config,
          metadataSnapshot,
          workspaceDir: "/tmp/agent-workspace",
        });
        expect(plan.pluginIds ?? []).toEqual(enabled ? ["fixture-memory"] : []);
      }
      expect(rebuildManifests).not.toHaveBeenCalled();
    } finally {
      rebuildManifests.mockRestore();
    }
  });

  it("keeps standalone activation unrestricted when no complete startup base exists", () => {
    const plan = loadPlan({
      metadataSnapshot: createMemoryPlanMetadataSnapshot(),
      config: {
        plugins: {
          entries: { "custom-context-engine": { enabled: true } },
        },
      },
      workspaceDir: "/tmp/workspace",
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });

    expect(plan.config?.plugins?.allow).toBeUndefined();
    expect(plan.config?.plugins?.entries).toMatchObject({
      "custom-context-engine": { enabled: true },
      codex: { enabled: true },
    });
  });

  it("checks restrictive allowlists against the selected harness owner plugin id", () => {
    mocks.resolveManifestActivationPlan.mockReturnValueOnce({
      entries: [{ pluginId: "custom-harness-plugin", origin: "workspace" }],
    });
    const plan = loadPlan({
      metadataSnapshot: createMemoryPlanMetadataSnapshot(),
      config: { plugins: { allow: ["custom-harness-plugin"] } },
      workspaceDir: "/tmp/workspace",
      selections: [
        { provider: "custom-provider", modelId: "custom-model", runtime: "custom-harness" },
      ],
    });

    expect(plan.pluginIds).toEqual(["custom-harness-plugin"]);
    expect(plan.config?.plugins?.entries?.["custom-harness-plugin"]).toEqual({ enabled: true });
  });

  it.each<[NonNullable<OpenClawConfig["plugins"]>, string[], string[]]>([
    [
      { slots: { memory: "memory-core" } },
      ["codex", "memory-core", "telegram"],
      ["telegram", "memory-core", "codex"],
    ],
    [{ allow: ["codex"] }, ["codex"], ["codex"]],
  ])("preserves startup scope under activation policy %j", (plugins, pluginIds, allow) => {
    const plan = runtimePlan({
      config: { plugins },
      basePluginIds: ["telegram"],
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });
    expect(plan).toMatchObject({ pluginIds, config: { plugins: { allow } } });
  });

  it("retains safe provider-owner dependencies for an explicitly allowed Codex harness", () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(["openai"]);
    mocks.resolveActivatableProviderOwnerPluginIds.mockReturnValueOnce(["openai"]);
    const plan = runtimePlan({
      config: { plugins: { allow: ["codex"] } },
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });
    expect(plan.pluginIds).toEqual(["codex", "openai"]);
    expect(plan.config?.plugins?.allow).toEqual(["codex", "openai"]);
    expect(plan.config?.plugins?.entries).toMatchObject({
      codex: { enabled: true },
      openai: { enabled: true },
    });
  });

  it("reports a harness unavailable when no enabled owner plugin can activate", () => {
    mocks.resolveManifestActivationPlan.mockReturnValueOnce({ entries: [] });
    expect(availability()).toEqual({
      status: "unavailable",
      ownerPluginIds: [],
      reason: "owner-plugin-not-activatable",
      detail: 'No enabled plugin owns agent harness "codex".',
    });
  });

  it.each([
    ["codex", { status: "unavailable", reason: "owner-plugin-degraded" }],
    ["stale-codex", { status: "available", ownerPluginIds: ["codex"] }],
  ] as const)(
    "checks quarantine against selected root, not %s artifacts",
    (directory, expected) => {
      const result = availability({
        payloadCheckedPluginIds: ["codex"],
        selectedPluginRootDirs: new Map([["codex", "/tmp/plugins/codex"]]),
        payloadFailures: [
          {
            pluginId: "codex",
            installPath: `/tmp/plugins/${directory}`,
            reason: "missing-package-dir",
          },
        ],
      });
      if (directory === "stale-codex") {
        expect(result).toEqual(expected);
      } else {
        expect(result).toMatchObject(expected);
      }
    },
  );

  it("reports an owner whose payload was not checked", () => {
    expect(
      availability({
        selectedPluginRootDirs: new Map([["codex", "/tmp/plugins/codex"]]),
      }),
    ).toMatchObject({ status: "unavailable", reason: "owner-plugin-unverified" });
  });
});
