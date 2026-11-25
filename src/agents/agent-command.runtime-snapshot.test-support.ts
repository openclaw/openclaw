import { vi } from "vitest";

/** Mutable command fixtures do not publish config revisions or source snapshots. */
export function createMutableRuntimeSnapshotMock(params: {
  getRuntimeConfigSnapshot: () => unknown;
  hashRuntimeConfigValue: typeof import("../config/runtime-snapshot.js").hashRuntimeConfigValue;
}) {
  return {
    ...params,
    getRuntimeConfigSnapshotMetadata: () => null,
    getRuntimeConfigSourceSnapshot: () => null,
    // Without published metadata the real key falls back to the value hash.
    resolveRuntimeConfigCacheKey: (config: Parameters<typeof params.hashRuntimeConfigValue>[0]) =>
      `config:${params.hashRuntimeConfigValue(config)}`,
    registerRuntimeConfigSnapshotPreparer: vi.fn(),
    setRuntimeConfigSnapshot: vi.fn(),
  };
}
