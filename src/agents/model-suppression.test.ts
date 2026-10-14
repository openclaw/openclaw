// Covers generation-scoped suppression and reuse of the manifest resolver.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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

  afterEach(() => {
    setCurrentPluginMetadataSnapshot(undefined);
  });

  it("reads each concurrent generation's suppression rules across A/B/A interleaving", async () => {
    const config = {} satisfies OpenClawConfig;
    const snapshotA = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const snapshotB = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    setCurrentPluginMetadataSnapshot(snapshotB, { config });
    mocks.buildManifestBuiltInModelSuppressionResolver.mockImplementation(() => {
      const snapshot = getCurrentPluginMetadataSnapshot({ config, env: process.env });
      return () =>
        snapshot === snapshotA ? { suppress: true, errorMessage: "generation A" } : undefined;
    });
    let releaseA!: () => void;
    let markAReady!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const aReady = new Promise<void>((resolve) => {
      markAReady = resolve;
    });
    const resultA = withPluginRuntimeGenerationScope({ metadataSnapshot: snapshotA }, async () => {
      const result = resolveBuiltInModelSuppressionFromManifest({
        provider: "openai",
        id: "generation-model",
        config,
      })?.suppress;
      markAReady();
      await holdA;
      return [
        result,
        resolveBuiltInModelSuppressionFromManifest({
          provider: "openai",
          id: "generation-model",
          config,
        })?.suppress,
      ];
    });
    await aReady;

    const resultB = await withPluginRuntimeGenerationScope(
      { metadataSnapshot: snapshotB },
      async () =>
        resolveBuiltInModelSuppressionFromManifest({
          provider: "openai",
          id: "generation-model",
          config,
        })?.suppress,
    );
    releaseA();

    await expect(resultA).resolves.toEqual([true, true]);
    expect(resultB).toBeUndefined();
    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(3);
  });

  describe("buildShouldSuppressBuiltInModelCore", () => {
    beforeEach(() => {
      mocks.buildManifestBuiltInModelSuppressionResolver.mockReset();
    });

    it("reuses the manifest owner for repeated model decisions", () => {
      const resolver = vi
        .fn()
        .mockReturnValueOnce({ suppress: true, errorMessage: "manifest suppression" })
        .mockReturnValueOnce(undefined);
      const config = {};
      mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValueOnce(resolver);

      const shouldSuppress = buildShouldSuppressBuiltInModelCore({ config });

      expect(shouldSuppress({ provider: "bedrock", id: "Claude-3" })).toBe(true);
      expect(shouldSuppress({ provider: "aws-bedrock", id: "claude-4" })).toBe(false);
      expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledOnce();
      expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledWith({
        config,
        env: process.env,
      });
    });
  });
});
