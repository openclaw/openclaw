import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { capturePluginGenerationArtifact } from "../plugins/plugin-generation-artifact.js";
import {
  getPluginGenerationMetrics,
  type PluginGenerationMetrics,
} from "../plugins/plugin-generation-metrics.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginSourceCaptureStorage } from "../plugins/plugin-source-capture-context.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { discardPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("snapshots registry preparation metrics before inherited asynchronous capture", async () => {
  const directory = temp.make("prepared-registry-metrics-");
  const source = path.join(directory, "plugin");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "index.cjs"), "exports.value = 42;");
  const release = createDeferred();
  let lateCapture: Promise<ReturnType<typeof capturePluginGenerationArtifact>> | undefined;
  let inheritedMetrics: PluginGenerationMetrics | undefined;
  const snapshot = createPluginMetadataSnapshotFixture({ plugins: [] });
  await using cache = createPluginCache();
  bindPluginMetadataSnapshotCache(snapshot, cache);
  const prepared = await withPluginSourceCaptureStorage(
    { stateDir: directory, placement: "temporary" },
    () =>
      withPluginCache(cache, () =>
        prepareWorkspaceBuildGroup(
          [
            {
              config: { models: { mode: "replace", providers: {} } },
              agentDir: path.join(directory, "agent"),
              skipCredentials: true,
            },
          ],
          "static",
          {
            loadRuntimeRegistry(_params, onPrimary) {
              lateCapture = release.promise.then(() => {
                inheritedMetrics = getPluginGenerationMetrics();
                return capturePluginGenerationArtifact(source);
              });
              const registry = createEmptyPluginRegistry();
              onPrimary?.(registry);
              return Promise.resolve(registry);
            },
          },
          undefined,
          undefined,
          snapshot,
        ),
      ),
  );
  const measured = { ...prepared.buildStats.pluginPreparation };
  try {
    expect(measured.captures).toBe(0);
    if (!lateCapture) {
      throw new Error("Registry preparation did not schedule its capture");
    }
    release.resolve();
    const artifact = await lateCapture;
    try {
      expect(inheritedMetrics?.captures).toBe(1);
      expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
        "exports.value = 42;",
      );
      expect(prepared.buildStats.pluginPreparation).toEqual(measured);
    } finally {
      await artifact.disposeAsync();
    }
  } finally {
    await discardPreparedPluginGeneration(prepared.pluginGeneration);
  }
});
