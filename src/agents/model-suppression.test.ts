import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";

const mocks = vi.hoisted(() => ({
  buildManifestBuiltInModelSuppressionResolver: vi.fn(),
}));

vi.mock("../plugins/manifest-model-suppression.js", () => ({
  buildManifestBuiltInModelSuppressionResolver: mocks.buildManifestBuiltInModelSuppressionResolver,
}));

import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  buildShouldSuppressBuiltInModelCore,
  resolveBuiltInModelSuppressionFromManifest,
} from "./model-suppression.js";

describe("model suppression", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReset();
  });

  afterEach(() => setCurrentPluginMetadataSnapshot(undefined));

  it("reads each concurrent generation's suppression rules across A/B/A interleaving", async () => {
    const config = {};
    const snapshotOptions = { config, manifestRegistry: { plugins: [], diagnostics: [] } };
    const snapshotA = createPluginMetadataSnapshot(snapshotOptions);
    const snapshotB = createPluginMetadataSnapshot(snapshotOptions);
    const resolve = () =>
      resolveBuiltInModelSuppressionFromManifest({
        provider: "openai",
        id: "generation-model",
        config,
      })?.suppress;
    setCurrentPluginMetadataSnapshot(snapshotB, { config });
    mocks.buildManifestBuiltInModelSuppressionResolver.mockImplementation(() => {
      const snapshot = getCurrentPluginMetadataSnapshot({ config, env: process.env });
      return () => (snapshot === snapshotA ? { suppress: true } : undefined);
    });
    const holdA = createDeferred();
    const aReady = createDeferred();
    const resultA = withPluginRuntimeGenerationScope({ metadataSnapshot: snapshotA }, async () => {
      const result = resolve();
      aReady.resolve();
      await holdA.promise;
      return [result, resolve()];
    });
    await aReady.promise;

    const resultB = await withPluginRuntimeGenerationScope(
      { metadataSnapshot: snapshotB },
      async () => resolve(),
    );
    holdA.resolve();

    await expect(resultA).resolves.toEqual([true, true]);
    expect(resultB).toBeUndefined();
    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "reuses the manifest owner for repeated decisions (prepared: %s)",
    (prepared) => {
      const resolver = vi
        .fn()
        .mockReturnValueOnce({ suppress: true })
        .mockReturnValueOnce(undefined);
      const config = {};
      const params = {
        config,
        ...(prepared
          ? {
              metadataSnapshot: createPluginMetadataSnapshot({
                config,
                manifestRegistry: { plugins: [], diagnostics: [] },
              }),
              workspaceDir: "/tmp/model-suppression-workspace",
              env: { OPENCLAW_STATE_DIR: "/tmp/model-suppression-state" },
            }
          : {}),
      };
      mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValueOnce(resolver);

      const shouldSuppress = buildShouldSuppressBuiltInModelCore(params);

      expect(shouldSuppress({ provider: "bedrock", id: "Claude-3" })).toBe(true);
      expect(shouldSuppress({ provider: "aws-bedrock", id: "claude-4" })).toBe(false);
      expect(mocks.buildManifestBuiltInModelSuppressionResolver.mock.calls).toEqual([
        [{ env: process.env, ...params }],
      ]);
    },
  );
});
