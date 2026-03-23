import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "./live-test-helpers.js";

describe("isLiveTestEnabled", () => {
  it("treats LIVE and OPENCLAW_LIVE_TEST as shared live gates", () => {
    expect(isLiveTestEnabled([], { LIVE: "1" })).toBe(true);
    expect(isLiveTestEnabled([], { OPENCLAW_LIVE_TEST: "1" })).toBe(true);
    expect(isLiveTestEnabled([], {})).toBe(false);
  });

  it("supports provider-specific live flags", () => {
    expect(isLiveTestEnabled(["MINIMAX_LIVE_TEST"], { MINIMAX_LIVE_TEST: "1" })).toBe(true);
    expect(isLiveTestEnabled(["MINIMAX_LIVE_TEST"], { MINIMAX_LIVE_TEST: "0" })).toBe(false);
  });
});
