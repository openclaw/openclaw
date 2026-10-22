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
    registerRuntimeConfigSnapshotPreparer: vi.fn(),
    setRuntimeConfigSnapshot: vi.fn(),
  };
}
