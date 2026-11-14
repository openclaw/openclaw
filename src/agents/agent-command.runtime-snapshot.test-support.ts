import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Mutable command fixtures do not publish config revisions or source snapshots. */
export function createMutableRuntimeSnapshotMock(params: {
  getRuntimeConfigSnapshot: () => unknown;
  hashRuntimeConfigValue: typeof import("../config/runtime-snapshot.js").hashRuntimeConfigValue;
}) {
  return {
    ...params,
    // No publication owner: retain the supplied mutable fixture, not process-wide config.
    createRuntimeConfigReader: (config: OpenClawConfig) => () => config,
    getRuntimeConfigSnapshotMetadata: () => null,
    getRuntimeConfigSourceSnapshot: () => null,
    registerRuntimeConfigSnapshotPreparer: vi.fn(),
    setRuntimeConfigSnapshot: vi.fn(),
  };
}
