import { isDeepStrictEqual } from "node:util";
import { vi } from "vitest";

/** Mutable command fixtures do not publish config revisions or source snapshots. */
export function createMutableRuntimeSnapshotMock<Config>(params: {
  getRuntimeConfigSnapshot: () => Config;
  hashRuntimeConfigValue: typeof import("../config/runtime-snapshot.js").hashRuntimeConfigValue;
}) {
  return {
    ...params,
    createRuntimeConfigReader: (inputConfig: Config) => {
      // Capture the binding before preparation yields; later replacements only
      // follow the runtime value, never an unrelated explicitly scoped config.
      const followsRuntimeConfig = isDeepStrictEqual(
        params.getRuntimeConfigSnapshot(),
        inputConfig,
      );
      return () => (followsRuntimeConfig ? params.getRuntimeConfigSnapshot() : null) ?? inputConfig;
    },
    getRuntimeConfigSnapshotMetadata: () => null,
    getRuntimeConfigSourceSnapshot: () => null,
    // Without published metadata the real key falls back to the value hash.
    resolveRuntimeConfigCacheKey: (config: Parameters<typeof params.hashRuntimeConfigValue>[0]) =>
      `config:${params.hashRuntimeConfigValue(config)}`,
    registerRuntimeConfigSnapshotPreparer: vi.fn(),
    setRuntimeConfigSnapshot: vi.fn(),
  };
}
