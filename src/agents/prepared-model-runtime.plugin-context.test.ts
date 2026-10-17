import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import * as artifactIdentity from "../plugins/plugin-runtime-artifact-identity.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

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

  it("owns setup code with admitted metadata while rerunning current activation inputs", async () => {
    const rootDir = temp.make("prepared-setup-owner-");
    const source = path.join(rootDir, "setup-api.cjs");
    fs.writeFileSync(
      source,
      `module.exports = { register(api) {
        api.registerAutoEnableProbe(({ config, env }) =>
          config.plugins.entries["setup-owner"].config.mode + ":" + env.OPENCLAW_SETUP_OWNER_TEST);
      } };`,
    );
    const manifestRegistry = makeRegistry([{ id: "setup-owner", channels: [], origin: "bundled" }]);
    Object.assign(manifestRegistry.plugins[0]!, {
      rootDir,
      source,
      setupSource: source,
      setup: { requiresRuntime: true },
    });
    const caches = Array.from({ length: 6 }, () => createPluginCache());
    using fingerprints = vi.spyOn(artifactIdentity, "fingerprintPluginRuntimeArtifact");
    try {
      for (const generation of [0, 1]) {
        const metadata = createPluginMetadataSnapshot({ manifestRegistry, workspaceDir: rootDir });
        bindPluginMetadataSnapshotCache(metadata, caches[generation * 3]!);
        for (const revision of [0, 1]) {
          const mode = `generation-${generation}-revision-${revision}`;
          const env = { OPENCLAW_SETUP_OWNER_TEST: `env-${revision}` };
          const config = { plugins: { entries: { "setup-owner": { config: { mode } } } } };
          const registry = createEmptyPluginRegistry();
          withPluginCache(caches[generation * 3 + revision + 1]!, () =>
            prepareOwnedPluginLoadContext(
              { config, workspaceDir: rootDir },
              env,
              registry,
              metadata,
              true,
            ),
          );
          expect(getPluginRuntimeLoadContext(registry)?.autoEnabledReasons).toEqual({
            "setup-owner": [`${mode}:env-${revision}`],
          });
          expect(fingerprints).toHaveBeenCalledTimes(generation + 1);
        }
        await retirePluginCache(caches[generation * 3]!);
      }
    } finally {
      await Promise.all(caches.map((cache) => retirePluginCache(cache)));
    }
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
