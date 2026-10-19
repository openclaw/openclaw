import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";

describe("prepared model runtime plugin metadata ownership", () => {
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  function preparedActivationFixture() {
    const config = { plugins: { entries: { synthetic: { config: { mode: "initial" } } } } };
    const activatedConfig = {
      plugins: {
        entries: {
          synthetic: { ...structuredClone(config.plugins.entries.synthetic), enabled: true },
        },
      },
    };
    const env = { OPENCLAW_ACTIVATION_TEST: "initial" };
    const workspaceDir = "/tmp/prepared-activation-workspace";
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([{ id: "synthetic", channels: [] }]),
      workspaceDir,
    });
    const registry = createEmptyPluginRegistry();
    setPluginRuntimeLoadContext(
      registry,
      {
        rawConfig: activatedConfig,
        config: activatedConfig,
        activationSourceConfig: config,
        autoEnabledReasons: { synthetic: ["prepared startup decision"] },
        workspaceDir,
        env,
        metadataSnapshot,
        manifestRegistry: metadataSnapshot.manifestRegistry,
        logger: { info() {}, warn() {}, error() {} },
        preferBuiltPluginArtifacts: true,
        expectedSourceDigests: { synthetic: "inbound-source-digest" },
      },
      "inbound-registration",
      { requestKey: "inbound-request", resolvedKey: "inbound-resolved" },
    );
    const prepare = (selectedConfig = config) => {
      const selectedRegistry = createEmptyPluginRegistry();
      prepareOwnedPluginLoadContext(
        { config: selectedConfig, workspaceDir },
        env,
        selectedRegistry,
        metadataSnapshot,
        true,
        registry,
      );
      return getPluginRuntimeLoadContext(selectedRegistry);
    };
    return { config, activatedConfig, metadataSnapshot, prepare };
  }

  it("carries admitted activation decisions from activated config into a selected runtime", () => {
    const fixture = preparedActivationFixture();
    const selectedContext = fixture.prepare(fixture.activatedConfig);
    expect(selectedContext?.config).toBe(fixture.activatedConfig);
    expect(selectedContext?.activationSourceConfig).toBe(fixture.config);
    expect(selectedContext?.autoEnabledReasons).toEqual({
      synthetic: ["prepared startup decision"],
    });
    expect(selectedContext?.metadataSnapshot).toBe(fixture.metadataSnapshot);
    expect(selectedContext?.loaderCacheIdentity).toBeUndefined();
    expect(selectedContext?.registrationConfigKey).not.toBe("inbound-registration");
    expect(selectedContext?.expectedSourceDigests).toBeUndefined();
  });

  it("keeps direct no-current preparation on the requested workspace", () => {
    const input = {
      config: { plugins: { allow: ["synthetic"] } },
      workspaceDir: "/tmp/direct-plugin-workspace",
    };
    const directSnapshot = createPluginMetadataSnapshot({
      ...input,
      manifestRegistry: makeRegistry([{ id: "synthetic", channels: [] }]),
    });
    using resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValue(directSnapshot);
    const registry = createEmptyPluginRegistry();

    expect(prepareOwnedPluginLoadContext(input, process.env, registry)).toBe(directSnapshot);
    expect(getPluginRuntimeLoadContext(registry)).toMatchObject({
      metadataSnapshot: directSnapshot,
      preferBuiltPluginArtifacts: false,
    });
    expect(resolveMetadata).toHaveBeenCalledWith({
      ...input,
      env: process.env,
      allowWorkspaceScopedCurrent: true,
    });
  });

  it("requests selected-runtime metadata for executable prepared probes", () => {
    const input = {
      config: { plugins: { slots: { memory: "none" as const } } },
      workspaceDir: "/tmp/selected-runtime-workspace",
    };
    const directSnapshot = createPluginMetadataSnapshot({
      ...input,
      manifestRegistry: makeRegistry([{ id: "selected", channels: [] }]),
    });
    using resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValue(directSnapshot);

    prepareOwnedPluginLoadContext(
      {
        ...input,
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: "selected", modelId: "model" }],
      },
      process.env,
      undefined,
    );

    expect(resolveMetadata).toHaveBeenCalledWith({
      ...input,
      env: process.env,
      allowWorkspaceScopedCurrent: true,
      pluginIdScope: expect.objectContaining({ key: expect.any(String) }),
    });
  });
});
