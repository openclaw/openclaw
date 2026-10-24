import { afterEach, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";

afterEach(clearPluginMetadataLifecycleCaches);

it("carries admitted activation decisions from activated config into a selected runtime", () => {
  const config: OpenClawConfig = { plugins: { entries: { synthetic: {} } } };
  const activatedConfig = structuredClone(config);
  activatedConfig.plugins!.entries!.synthetic!.enabled = true;
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
      expectedSourceDigests: { synthetic: "inbound-source-digest" },
    },
    "inbound-registration",
    { requestKey: "inbound-request", resolvedKey: "inbound-resolved" },
  );
  const selectedRegistry = createEmptyPluginRegistry();
  prepareOwnedPluginLoadContext(
    { config: activatedConfig, workspaceDir },
    env,
    selectedRegistry,
    metadataSnapshot,
    true,
    registry,
  );
  const selectedContext = getPluginRuntimeLoadContext(selectedRegistry);
  expect(selectedContext?.config).toBe(activatedConfig);
  expect(selectedContext?.activationSourceConfig).toBe(config);
  expect(selectedContext?.autoEnabledReasons).toEqual({
    synthetic: ["prepared startup decision"],
  });
  expect(selectedContext?.metadataSnapshot).toBe(metadataSnapshot);
  expect(selectedContext?.loaderCacheIdentity).toBeUndefined();
  expect(selectedContext?.registrationConfigKey).not.toBe("inbound-registration");
  expect(selectedContext?.expectedSourceDigests).toBeUndefined();
});

it.each([false, true])("prepares workspace metadata (executable probe: %s)", (executable) => {
  const input = {
    config: executable
      ? { plugins: { slots: { memory: "none" as const } } }
      : { plugins: { allow: ["synthetic"] } },
    workspaceDir: executable ? "/tmp/selected-runtime-workspace" : "/tmp/direct-plugin-workspace",
  };
  const directSnapshot = createPluginMetadataSnapshot({
    ...input,
    manifestRegistry: makeRegistry([{ id: executable ? "selected" : "synthetic", channels: [] }]),
  });
  using resolveMetadata = vi
    .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
    .mockReturnValue(directSnapshot);
  const registry = executable ? undefined : createEmptyPluginRegistry();
  const selection = executable
    ? {
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: "selected", modelId: "model" }],
      }
    : {};
  expect(prepareOwnedPluginLoadContext({ ...input, ...selection }, process.env, registry)).toBe(
    directSnapshot,
  );
  if (registry) {
    expect(getPluginRuntimeLoadContext(registry)).toMatchObject({
      metadataSnapshot: directSnapshot,
      preferBuiltPluginArtifacts: false,
    });
  }
  expect(resolveMetadata).toHaveBeenCalledWith({
    ...input,
    env: process.env,
    allowWorkspaceScopedCurrent: true,
    ...(executable ? { pluginIdScope: expect.objectContaining({ key: expect.any(String) }) } : {}),
  });
});
