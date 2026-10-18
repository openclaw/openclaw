import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { withEnv } from "../test-utils/env.js";
import { isHighSignalLiveModelRef } from "./test-helpers/live-model-dynamic-candidates.js";

describe("live model policy configuration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetPluginLoaderTestStateForTest();
    cleanupTrackedTempDirs(tempDirs);
  });

  it("selects a scoped plugin's modern models under Vitest", () => {
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

    withEnv(env, () => {
      expect(isHighSignalLiveModelRef(ref)).toBe(false);
      expect(isHighSignalLiveModelRef({ ...ref, config })).toBe(true);
      expect(isHighSignalLiveModelRef({ ...ref, config, id: "retired-model" })).toBe(false);
      expect(
        isHighSignalLiveModelRef({
          ...ref,
          config: { ...config, plugins: { ...config.plugins, enabled: false } },
        }),
      ).toBe(false);
    });
  });
});
