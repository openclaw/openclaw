import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { isHighSignalLiveModelRef } from "./test-helpers/live-model-dynamic-candidates.js";

describe("live model policy configuration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetPluginLoaderTestStateForTest();
    cleanupTrackedTempDirs(tempDirs);
  });

  it("selects a scoped plugin's modern models under Vitest", async () => {
    const rootDir = makeTrackedTempDir("openclaw-live-model-policy", tempDirs);
    const fixture = createColdPluginFixture({ rootDir });
    fs.writeFileSync(
      fixture.runtimeSource,
      `module.exports = {
        id: ${JSON.stringify(fixture.pluginId)},
        register(api) {
          api.registerProvider({
            id: ${JSON.stringify(fixture.providerId)},
            label: "Live model fixture",
            auth: [],
            isModernModelRef: ({ modelId }) => modelId === "current-model",
          });
        },
      };`,
    );
    const env = createColdPluginHermeticEnv(rootDir, {
      bundledPluginsDir: makeTrackedTempDir("openclaw-live-model-empty-bundles", tempDirs),
    });
    const config = createColdPluginConfig(rootDir, fixture.pluginId);
    const ref = { provider: fixture.providerId, id: "current-model", env };

    await withEnvAsync(env, async () => {
      expect(await isHighSignalLiveModelRef(ref)).toBe(false);
      expect(await isHighSignalLiveModelRef({ ...ref, config })).toBe(true);
      expect(await isHighSignalLiveModelRef({ ...ref, config, id: "retired-model" })).toBe(false);
      const disabledConfig = { ...config, plugins: { ...config.plugins, enabled: false } };
      expect(await isHighSignalLiveModelRef({ ...ref, config: disabledConfig })).toBe(false);
    });
  });
});
