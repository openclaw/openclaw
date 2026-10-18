import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  getActivePluginRegistry: vi.fn(),
  getActivePluginRegistryWorkspaceDir: vi.fn(),
  loadPluginRegistryHandle: vi.fn(),
  adoptRuntimeContextEngineRegistrations: vi.fn((target: unknown) => target),
  adoptRuntimeWidgetPresenterRegistrations: vi.fn((target: unknown) => target),
  resolveAgentRuntimePluginLoadPlan: vi.fn(),
  resolveAgentRuntimePluginSelections: vi.fn(
    (_config: unknown, selections: readonly unknown[]) => selections,
  ),
  resolveAgentHarnessOwnerPluginIds: vi.fn(() => ["codex"]),
}));

vi.mock("../context-engine/registry.js", () => ({
  adoptRuntimeContextEngineRegistrations: hoisted.adoptRuntimeContextEngineRegistrations,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: hoisted.getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir: hoisted.getActivePluginRegistryWorkspaceDir,
}));

vi.mock("../plugins/widget-presenters.js", () => ({
  adoptRuntimeWidgetPresenterRegistrations: hoisted.adoptRuntimeWidgetPresenterRegistrations,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: hoisted.loadPluginMetadataSnapshot,
}));

vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: hoisted.loadPluginRegistryHandle,
}));

vi.mock("./harness/runtime-plugin-load-plan.js", () => ({
  resolveAgentHarnessOwnerPluginIds: hoisted.resolveAgentHarnessOwnerPluginIds,
  resolveAgentRuntimePluginLoadPlan: hoisted.resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelections: hoisted.resolveAgentRuntimePluginSelections,
}));

import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  captureRuntimeConfig,
  projectConfigOntoRuntimeSourceSnapshot,
} from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getCurrentPluginMetadataSnapshot,
  setGatewayPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { selectCurrentPluginMetadataCache } from "../plugins/current-plugin-metadata-state.js";
import { validatePluginConfig } from "../plugins/loader-shared.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getProcessPluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-selection.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { bindPluginRegistryGatewayOwner } from "../plugins/registry-lifecycle.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import {
  createPreparedInboundRegistryLoader,
  prepareWorkspacePluginRegistries,
  type PreparedInboundRegistryLoader,
} from "./prepared-model-runtime.inbound-registry.js";
import {
  loadAgentRuntimePluginRegistryHandle,
  withAgentPluginRegistry,
} from "./runtime-plugins.js";

function createMetadataSnapshot(workspaceDir = "/tmp/gateway-workspace") {
  return {
    workspaceDir,
    index: { installRecords: {}, plugins: [] },
    manifestRegistry: { diagnostics: [], plugins: [] },
    discovery: { candidates: [], diagnostics: [] },
    pluginIds: ["telegram", "memory-core"],
  };
}

const directWorkspaceDir = "/tmp/workspace";
const disabledConfig = { plugins: { enabled: false } } satisfies OpenClawConfig;
function keyConfig(apiKey: unknown): OpenClawConfig {
  return { plugins: { entries: { fixture: { enabled: true, config: { apiKey } } } } };
}
function secretRef(id: string) {
  return { source: "store", provider: "default", id };
}
function registryWith(...ids: string[]) {
  const registry = createEmptyPluginRegistry();
  registry.plugins = ids.map((id) => createPluginRecord({ id }));
  return registry;
}
function expectPolicyError(error: unknown, ...messages: string[]) {
  expect(error).toBeInstanceOf(Error);
  for (const message of messages) {
    expect((error as Error).message).toContain(message);
  }
}

function createGatewayRegistryFixture() {
  const config: OpenClawConfig = {
    plugins: { entries: { "gateway-owned": { config: { mode: "initial" } } } },
  };
  const workspaceDir = "/tmp/default-workspace";
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    workspaceDir,
    manifestRegistry: makeRegistry([
      { id: "gateway-owned", origin: "bundled", channels: [] },
      { id: "deferred", origin: "bundled", channels: [] },
    ]),
  });
  const activeRegistry = createEmptyPluginRegistry();
  activeRegistry.plugins = metadataSnapshot.plugins.map((manifest) => {
    const record = createPluginRecord({
      id: manifest.id,
      rootDir: manifest.rootDir,
      source: manifest.source,
      origin: manifest.origin,
      format: "openclaw",
      imported: manifest.id !== "deferred",
    });
    bindPluginRuntimeArtifactSelection(record, {
      preferBuiltPluginArtifacts: false,
      runtimeEntry: resolvePluginRuntimeArtifactSelection({
        ...manifest,
        entryKind: "runtime",
        preferBuiltPluginArtifacts: false,
      }),
    });
    return record;
  });
  const activationContext = {
    rawConfig: config,
    config: structuredClone(config),
    activationSourceConfig: config,
    autoEnabledReasons: { "gateway-owned": ["prepared Gateway activation"] },
    workspaceDir,
    env: { ...process.env },
    metadataSnapshot,
    manifestRegistry: metadataSnapshot.manifestRegistry,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  setPluginRuntimeLoadContext(activeRegistry, activationContext);
  hoisted.getActivePluginRegistry.mockReturnValue(activeRegistry);
  hoisted.getActivePluginRegistryWorkspaceDir.mockReturnValue(workspaceDir);
  bindPluginRegistryGatewayOwner(activeRegistry, { current: () => activeRegistry });
  return { config, workspaceDir, metadataSnapshot, activeRegistry, activationContext };
}

describe("agent runtime plugin registries", () => {
  beforeEach(() => {
    for (const mock of Object.values(hoisted)) {
      mock.mockReset();
    }
    hoisted.loadPluginMetadataSnapshot.mockImplementation((params: { workspaceDir?: string }) => ({
      ...createMetadataSnapshot(params.workspaceDir),
      pluginIds: undefined,
    }));
    hoisted.loadPluginRegistryHandle.mockImplementation(() => createEmptyPluginRegistry());
    hoisted.resolveAgentRuntimePluginLoadPlan.mockImplementation(({ config }) => ({
      config,
      pluginIds: ["codex", "memory-core"],
    }));
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    for (const [options] of hoisted.loadPluginRegistryHandle.mock.calls) {
      expect(options).not.toHaveProperty("capabilityCatalogContext");
      expect(options.runtimeOptions ?? {}).not.toHaveProperty("modelAuth");
      expect(options.runtimeOptions ?? {}).not.toHaveProperty("modelConfig");
    }
  });

  it.each([false, true])(
    "validates captured SecretRefs after rotation (policy projected: %s)",
    (projected) => {
      const source = keyConfig(secretRef("SYNTHETIC_KEY"));
      const runtime = keyConfig("synthetic-prepared");
      setRuntimeConfigSnapshot(runtime, source);
      const captured = captureRuntimeConfig(runtime);
      const capturedSource = projectConfigOntoRuntimeSourceSnapshot(captured);
      setRuntimeConfigSnapshot(
        keyConfig("synthetic-successor"),
        keyConfig(secretRef("SYNTHETIC_SUCCESSOR")),
      );
      hoisted.resolveAgentRuntimePluginLoadPlan.mockImplementation(({ config }) => ({
        config: projected
          ? { ...config, plugins: { ...config.plugins, allow: ["fixture"] } }
          : config,
        pluginIds: ["fixture"],
      }));
      hoisted.loadPluginRegistryHandle.mockImplementation((options) => {
        const result = validatePluginConfig({
          origin: "global",
          schema: {
            type: "object",
            required: ["apiKey"],
            properties: { apiKey: { type: "object", required: ["source", "provider", "id"] } },
          },
          value: options.config.plugins.entries.fixture.config,
          sourceValue: options.activationSourceConfig.plugins.entries.fixture.config,
        });
        expect(result).toEqual({ ok: true, value: { apiKey: "synthetic-prepared" } });
        expect(options.activationSourceConfig.plugins.allow).toEqual(
          projected ? ["fixture"] : undefined,
        );
        if (!projected) {
          expect(options.activationSourceConfig).toBe(capturedSource);
        }
        expect(options.activationSourceConfig.plugins.entries.fixture.config).toEqual(
          source.plugins?.entries?.fixture?.config,
        );
        return createEmptyPluginRegistry();
      });
      loadAgentRuntimePluginRegistryHandle({ config: captured, workspaceDir: "/synthetic" });
      expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledOnce();
      expect(source.plugins?.allow).toBeUndefined();
    },
  );

  it.each([
    ["model-catalog", false],
    ["model-catalog", true],
    ["isolated-completion", false],
    ["isolated-completion", true],
  ] as const)("keeps %s registries exact with broader reusable scope=%s", (purpose, broader) => {
    const reusableRegistry = registryWith("catalog-provider", ...(broader ? ["memory-core"] : []));
    const primaryRegistry = registryWith("catalog-provider");
    hoisted.getActivePluginRegistry.mockReturnValue(createEmptyPluginRegistry());
    hoisted.loadPluginRegistryHandle.mockReturnValue(primaryRegistry);
    hoisted.resolveAgentRuntimePluginLoadPlan.mockReturnValue({
      config: {},
      pluginIds: ["catalog-provider"],
    });

    const registry = loadAgentRuntimePluginRegistryHandle({
      config: {},
      basePluginIds: ["catalog-provider"],
      reusableRegistry,
      purpose,
    });

    expect(registry).toBe(broader ? primaryRegistry : reusableRegistry);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledTimes(broader ? 1 : 0);
    expect(hoisted.adoptRuntimeContextEngineRegistrations).not.toHaveBeenCalled();
    expect(hoisted.adoptRuntimeWidgetPresenterRegistrations).not.toHaveBeenCalled();
  });

  it("reuses the current Gateway generation and loads only the imported-plugin delta", async () => {
    const { config, workspaceDir, metadataSnapshot, activeRegistry } =
      createGatewayRegistryFixture();
    const selectedRegistry = registryWith("selected-provider");
    selectedRegistry.plugins.unshift(...activeRegistry.plugins);
    hoisted.loadPluginRegistryHandle.mockReturnValue(selectedRegistry);
    hoisted.resolveAgentRuntimePluginLoadPlan.mockImplementation(({ basePluginIds }) => ({
      config,
      pluginIds: [...(basePluginIds ?? []), "selected-provider"],
    }));

    const prepared = await withPluginRuntimeRegistryScope(activeRegistry, () =>
      prepareWorkspacePluginRegistries(
        {
          agentDir: "/tmp/agent",
          allowGatewaySubagentBinding: true,
          config,
          runtimePluginSelections: [{ provider: "selected", modelId: "model" }],
          workspaceDir,
        },
        metadataSnapshot as never,
        vi.fn(),
        createPreparedInboundRegistryLoader(),
        true,
      ),
    );

    expect(prepared.inboundPluginRegistry).toBe(activeRegistry);
    expect(prepared.runtimePluginRegistry).toBe(selectedRegistry);
    expect(hoisted.resolveAgentRuntimePluginLoadPlan.mock.calls[0]?.[0].basePluginIds).toEqual([
      "gateway-owned",
    ]);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledOnce();
    const loadedOptions = hoisted.loadPluginRegistryHandle.mock.calls[0]?.[0];
    expect(loadedOptions).toMatchObject({
      onlyPluginIds: ["gateway-owned", "selected-provider"],
      preferBuiltPluginArtifacts: true,
    });
  });

  it("reuses the published Gateway registry inside the reload operation cache", async () => {
    const { config, workspaceDir, metadataSnapshot, activeRegistry } =
      createGatewayRegistryFixture();
    const previousCache = getProcessPluginCache();
    await using operationCache = createPluginCache();
    await using publishedCache = createPluginCache();
    bindPluginMetadataSnapshotCache(metadataSnapshot, publishedCache);
    try {
      await withPluginCache(operationCache, async () => {
        setGatewayPluginMetadataSnapshot(metadataSnapshot, { config, workspaceDir });
        await Promise.resolve();
        const readParams = { config, workspaceDir, allowWorkspaceScopedSnapshot: true };
        expect(
          withPluginCache(publishedCache, () => getCurrentPluginMetadataSnapshot(readParams)),
        ).toBe(metadataSnapshot);
        expect(getCurrentPluginMetadataSnapshot(readParams)).toBeUndefined();

        expect(
          withPluginRuntimeRegistryScope(activeRegistry, () =>
            createPreparedInboundRegistryLoader()(
              { allowGatewaySubagentBinding: true, config, workspaceDir },
              metadataSnapshot,
            ),
          ),
        ).toBe(activeRegistry);
        expect(hoisted.loadPluginRegistryHandle).not.toHaveBeenCalled();
      });
    } finally {
      selectCurrentPluginMetadataCache(previousCache);
    }
  });

  it.each([
    "custom environment",
    "non-bindable mode",
    "different workspace",
    "stale metadata generation",
    "changed input config",
    "manifest mismatch",
  ] as const)("refuses Gateway registry reuse for %s", (reason) => {
    const fixture = createGatewayRegistryFixture();
    const { activeRegistry, activationContext } = fixture;
    const input: Parameters<PreparedInboundRegistryLoader>[0] = {
      allowGatewaySubagentBinding: true,
      config: fixture.config,
      workspaceDir: fixture.workspaceDir,
    };
    switch (reason) {
      case "custom environment":
        input.env = { OPENCLAW_STATE_DIR: "/tmp/custom-state" };
        break;
      case "non-bindable mode":
        input.allowGatewaySubagentBinding = false;
        break;
      case "different workspace":
        setPluginRuntimeLoadContext(activeRegistry, {
          ...activationContext,
          workspaceDir: "/tmp/other",
        });
        break;
      case "stale metadata generation":
        fixture.metadataSnapshot = { ...fixture.metadataSnapshot };
        break;
      case "changed input config":
        input.config = disabledConfig;
        break;
      case "manifest mismatch":
        activeRegistry.plugins[0]!.origin = "global";
        break;
    }
    expect(
      withPluginRuntimeRegistryScope(activeRegistry, () =>
        createPreparedInboundRegistryLoader()(input, fixture.metadataSnapshot),
      ),
    ).not.toBe(activeRegistry);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledOnce();
  });

  it("does not reuse a batch registry across metadata generations with identical config", () => {
    const input = { config: {}, workspaceDir: directWorkspaceDir };
    const firstMetadata = createMetadataSnapshot(input.workspaceDir);
    const replacementMetadata = createMetadataSnapshot(input.workspaceDir);
    const load = createPreparedInboundRegistryLoader();

    const first = load(input, firstMetadata as never);
    expect(load(input, firstMetadata as never)).toBe(first);
    const replacement = load(input, replacementMetadata as never);
    expect(replacement).not.toBe(first);
    expect(load(input, replacementMetadata as never)).toBe(replacement);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledTimes(2);
  });

  it("carries low-level reply policy without rebinding the loader's cached registry", async () => {
    const config = disabledConfig;
    const cachedRegistry = createEmptyPluginRegistry();
    hoisted.loadPluginRegistryHandle.mockReturnValue(cachedRegistry);
    const pluginRegistry = loadAgentRuntimePluginRegistryHandle({
      config,
      workspaceDir: directWorkspaceDir,
      allowGatewaySubagentBinding: true,
    });
    const error = await ensureSelectedAgentHarnessPlugin({
      config,
      provider: "openai",
      modelId: "gpt-5.5",
      agentHarnessRuntimeOverride: "codex",
      workspaceDir: directWorkspaceDir,
      pluginRegistry,
    }).catch((cause: unknown) => cause);

    expectPolicyError(error, "plugins disabled");
    expect(pluginRegistry).toBe(cachedRegistry);
    expect(getPluginRuntimeLoadContext(cachedRegistry)).toBeUndefined();
    expect(hoisted.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it.each(["disabled", "allowlisted"])(
    "reports exact policy facts for %s direct hosts",
    async (policy) => {
      const disabled = policy === "disabled";
      const config: OpenClawConfig = disabled
        ? disabledConfig
        : { plugins: { allow: ["openai", "memory-core"] } };
      const pluginRegistry = createEmptyPluginRegistry();
      hoisted.loadPluginRegistryHandle.mockReturnValue(pluginRegistry);
      if (!disabled) {
        hoisted.loadPluginMetadataSnapshot.mockReturnValue(
          createPluginMetadataSnapshot({
            config,
            workspaceDir: directWorkspaceDir,
            manifestRegistry: makeRegistry([
              {
                id: "codex",
                channels: [],
                activation: { onAgentHarnesses: ["codex"] },
                origin: "bundled",
              },
            ]),
          }),
        );
      }

      const error = await withAgentPluginRegistry({
        config,
        workspaceDir: directWorkspaceDir,
        run: async () => {
          await ensureSelectedAgentHarnessPlugin({
            provider: "openai",
            modelId: "gpt-5.5",
            config,
            agentHarnessRuntimeOverride: disabled ? "custom-harness" : "codex",
            workspaceDir: directWorkspaceDir,
            pluginRegistry: getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
          });
        },
      }).catch((cause: unknown) => cause);

      expectPolicyError(
        error,
        disabled
          ? "no plugin can register agent harness"
          : 'Owner plugin "codex" is not activatable',
        disabled ? "Plugins are disabled" : "not in allowlist",
        "reason=owner-plugin-not-activatable",
      );
      expect((error as Error).message).not.toContain("absent from this prepared plugin generation");
      expect(hoisted.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(disabled ? 0 : 1);
    },
  );

  it("reuses an existing gateway registry owner", async () => {
    const gatewayRegistry = { gateway: true } as never;

    await expect(
      withPluginRuntimeRegistryScope(gatewayRegistry, () =>
        withAgentPluginRegistry({
          config: {} as never,
          workspaceDir: directWorkspaceDir,
          run: async () => getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
        }),
      ),
    ).resolves.toBe(gatewayRegistry);

    expect(hoisted.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });
});
