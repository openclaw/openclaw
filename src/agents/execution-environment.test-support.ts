import path from "node:path";
import { onTestFinished } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/test-helpers/contracts-testkit.js";
import { isBundledPluginEnabled } from "../plugins/config-state.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../test-utils/bundled-plugin-public-surface.js";

const entry = resolveBundledPluginPublicModulePath({
  pluginId: "github-repositories",
  artifactBasename: "index.ts",
});
const loadedManifest = loadPluginManifest(path.dirname(entry));
if (!loadedManifest.ok) {
  throw new Error(loadedManifest.error);
}
const manifest = loadedManifest.manifest;
const { default: repositoryPlugin } = await loadBundledPluginFacade<{
  default: OpenClawPluginDefinition;
}>({ pluginId: "github-repositories", artifactBasename: "index.ts" });
const declaredRegister = repositoryPlugin.register;
if (!declaredRegister) {
  throw new Error("The GitHub repository entry did not declare its register operation");
}
const registerRepositoryPlugin = declaredRegister;

/** Exercise the real registrar/instance binding without starting account or network services. */
export function createGitHubExecutionFixture(config: OpenClawConfig) {
  const fixture = createPluginRegistryFixture(config);
  const record = createPluginRecord({
    id: manifest.id,
    source: entry,
    origin: "bundled",
    contracts: manifest.contracts,
    repositorySources: manifest.repositorySources,
    dashboard: manifest.dashboard,
  });
  if (isBundledPluginEnabled(config, record.id)) {
    registerTestPlugin({
      ...fixture,
      record,
      register: registerRepositoryPlugin,
    });
    onTestFinished(async () => {
      await getPluginInstance(record)?.dispose();
    });
  }
  return {
    registry: fixture.registry.registry,
    close: () => getPluginInstance(record)?.dispose(),
    run<T>(run: () => T): T {
      return withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: fixture.registry.registry, isWebchatConnect: () => false },
        run,
      );
    },
  };
}

/** Use the ordinary CLI secret-preparation owner, including dormant metadata exclusions. */
export async function activateExecutionSecretSnapshot(
  config: OpenClawConfig,
  stateDir: string,
  assignmentConfig: OpenClawConfig = config,
) {
  const {
    activateSecretsRuntimeSnapshot,
    clearSecretsRuntimeSnapshot,
    prepareSecretsRuntimeSnapshot,
  } = await import("../secrets/runtime.js");
  const snapshot = await prepareSecretsRuntimeSnapshot({
    config,
    assignmentConfig,
    env: { OPENCLAW_STATE_DIR: stateDir, HOME: stateDir },
    includeConfigRefs: false,
    includeAuthStoreRefs: false,
    agentDirs: [],
    loadablePluginOrigins: new Map([["github-repositories", "bundled"]]),
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "github-repositories",
          origin: "bundled",
        },
      ],
    }),
  });
  activateSecretsRuntimeSnapshot(snapshot);
  onTestFinished(clearSecretsRuntimeSnapshot);
  return snapshot;
}
