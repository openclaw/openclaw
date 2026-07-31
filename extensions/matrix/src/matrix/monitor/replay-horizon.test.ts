import { describe, expect, it } from "vitest";
import { MATRIX_UNCLEAN_RESTART_REPLAY_MS, resolveMatrixReplayCutoffMs } from "./replay-horizon.js";

describe("resolveMatrixReplayCutoffMs", () => {
  const startupMs = 1_000_000;
  const startupGraceMs = 30_000;

  it("fences a cold start at the startup grace boundary", () => {
    expect(
      resolveMatrixReplayCutoffMs({
        hasPersistedSyncState: false,
        hasCleanShutdownSyncState: false,
        startupMs,
        startupGraceMs,
      }),
    ).toBe(startupMs - startupGraceMs);
  });

  it("removes the fence after a clean shutdown", () => {
    expect(
      resolveMatrixReplayCutoffMs({
        hasPersistedSyncState: true,
        hasCleanShutdownSyncState: true,
        startupMs,
        startupGraceMs,
      }),
    ).toBeNull();
  });

  it("bounds an unclean restart to the crash replay window", () => {
    expect(
      resolveMatrixReplayCutoffMs({
        hasPersistedSyncState: true,
        hasCleanShutdownSyncState: false,
        startupMs,
        startupGraceMs,
      }),
    ).toBe(startupMs - MATRIX_UNCLEAN_RESTART_REPLAY_MS);
  });

  it("keeps the cold-start fence when no cursor exists even if the marker is clean", () => {
    expect(
      resolveMatrixReplayCutoffMs({
        hasPersistedSyncState: false,
        hasCleanShutdownSyncState: true,
        startupMs,
        startupGraceMs,
      }),
    ).toBe(startupMs - startupGraceMs);
  });
});
