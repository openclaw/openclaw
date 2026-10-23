import { describe, expect, it, vi } from "vitest";
import { readCodexExperimentalFeature } from "./experimental-features.js";
import type { CodexExperimentalFeatureListResponse } from "./protocol-control-plane.js";

describe("readCodexExperimentalFeature", () => {
  it.each([true, false])("finds an enabled=%s feature on a later scoped page", async (enabled) => {
    const request = vi
      .fn<() => Promise<CodexExperimentalFeatureListResponse>>()
      .mockResolvedValueOnce({ data: [{ name: "other", enabled: true }], nextCursor: "next" })
      .mockResolvedValueOnce({ data: [{ name: "apps", enabled }], nextCursor: null });

    await expect(readCodexExperimentalFeature(request, "apps", "thread-1")).resolves.toBe(enabled);
    expect(request.mock.calls).toEqual([
      [{ limit: 100, threadId: "thread-1" }],
      [{ limit: 100, threadId: "thread-1", cursor: "next" }],
    ]);
  });

  it("leaves an absent feature unknown and terminates repeated cursors", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], nextCursor: "same" });
    await expect(readCodexExperimentalFeature(request, "apps")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    await expect(
      readCodexExperimentalFeature(async () => ({ data: [], nextCursor: null }), "apps"),
    ).resolves.toBeUndefined();
  });

  it("leaves request failures to the caller's evidence or credential policy", async () => {
    const error = new Error("unavailable");
    await expect(
      readCodexExperimentalFeature(async () => {
        throw error;
      }, "apps"),
    ).rejects.toBe(error);
  });
});
