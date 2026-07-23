// Zalouser tests cover probe plugin behavior.
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeZalouser } from "./probe.js";
import { getZaloUserInfo } from "./zalo-js.js";

vi.mock("./zalo-js.js", () => ({
  getZaloUserInfo: vi.fn(),
}));

const mockGetUserInfo = vi.mocked(getZaloUserInfo);

describe("probeZalouser", () => {
  beforeEach(() => {
    mockGetUserInfo.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns ok=true with user when authenticated", async () => {
    mockGetUserInfo.mockResolvedValueOnce({
      userId: "123",
      displayName: "Alice",
    });

    await expect(probeZalouser("default")).resolves.toEqual({
      ok: true,
      user: { userId: "123", displayName: "Alice" },
    });
  });

  it("returns not authenticated when no user info is returned", async () => {
    mockGetUserInfo.mockResolvedValueOnce(null);
    await expect(probeZalouser("default")).resolves.toEqual({
      ok: false,
      error: "Not authenticated",
    });
  });

  it("returns error when user lookup throws", async () => {
    mockGetUserInfo.mockRejectedValueOnce(new Error("network down"));
    await expect(probeZalouser("default")).resolves.toEqual({
      ok: false,
      error: "network down",
    });
  });

  it("times out when lookup takes too long", async () => {
    vi.useFakeTimers();
    mockGetUserInfo.mockReturnValueOnce(new Promise(() => {}));

    const pending = probeZalouser("default", 10);
    await vi.advanceTimersByTimeAsync(1000);

    const probe = await pending;
    expect(probe).toEqual({
      ok: false,
      error: "timed out",
    });
    // Same summary builder wired by zalouserPlugin.status.buildChannelSummary —
    // proves the timeout string is what channel status surfaces as probe.error.
    const summary = buildPassiveProbedChannelStatusSummary({
      configured: true,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      probe,
      lastProbeAt: 1,
    });
    expect(summary.probe).toMatchObject({ ok: false, error: "timed out" });
    const probeError =
      summary.probe && typeof summary.probe === "object" && "error" in summary.probe
        ? String((summary.probe as { error?: unknown }).error)
        : "";
    console.log(
      `[zalouser channel-visible timeout proof] timed_out=true summary.probe.error=${probeError} not_authenticated=${probeError === "Not authenticated"}`,
    );
  });

  it("still reports Not authenticated when lookup returns null before timeout", async () => {
    vi.useFakeTimers();
    mockGetUserInfo.mockResolvedValueOnce(null);

    const pending = probeZalouser("default", 5_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "Not authenticated",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the probe timeout after auth resolves", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    mockGetUserInfo.mockResolvedValueOnce({
      userId: "123",
      displayName: "Alice",
    });

    await expect(probeZalouser("default", 10)).resolves.toEqual({
      ok: true,
      user: { userId: "123", displayName: "Alice" },
    });

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps oversized lookup timeout before scheduling", async () => {
    vi.useFakeTimers();
    mockGetUserInfo.mockReturnValueOnce(new Promise(() => {}));
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    void probeZalouser("default", Number.MAX_SAFE_INTEGER);

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});
