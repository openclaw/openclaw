import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { onTestFinished, vi } from "vitest";
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
import { capturePreparedExecutionEnvironment } from "./execution-environment.js";

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

/** Prepare one managed profile through the real provider for native launch/approval fixtures. */
export function prepareManagedGitHubExecutionFixture() {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delayed-github-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const config: OpenClawConfig = {
    plugins: {
      entries: {
        "github-repositories": {
          config: { system: { profileId: "ghp_11111111111111111111111111111111" } },
        },
      },
    },
  };
  const execution = createGitHubExecutionFixture(config);
  const environment = capturePreparedExecutionEnvironment(
    { config, agentId: "main", assertCurrent() {} },
    execution.registry,
  );
  const profileDir = expectDefined(
    environment.localIdentityEnv.GH_CONFIG_DIR,
    "managed GitHub profile",
  );
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  return {
    environment,
    profileDir,
    cleanup: () => {
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
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
