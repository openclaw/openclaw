import { beforeEach, describe, expect, it, vi } from "vitest";

const inspectFaceTimeDriver = vi.fn();
vi.mock("../src/driver-setup.js", () => ({
  inspectFaceTimeDriver: (params: unknown) => inspectFaceTimeDriver(params),
}));

const { buildFaceTimeCallUrl, parseClickToCallOutcome, placeClickToCallCarrier } =
  await import("../src/carrier-click-to-call.js");

const runCommandWithTimeout = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  inspectFaceTimeDriver.mockResolvedValue("current");
});

describe("buildFaceTimeCallUrl", () => {
  it("uses the audio scheme for audio calls", () => {
    expect(buildFaceTimeCallUrl("vnsaccardi@icloud.com", "audio")).toBe(
      "facetime-audio://vnsaccardi%40icloud.com",
    );
  });

  it("uses the video scheme for video calls", () => {
    expect(buildFaceTimeCallUrl("+14402427312", "video")).toBe("facetime://%2B14402427312");
  });
});

describe("parseClickToCallOutcome", () => {
  it("reports a live call", () => {
    expect(parseClickToCallOutcome("LIVE:FaceTime Audio - 0:12")).toEqual({
      placed: true,
      live: true,
      detail: "FaceTime Audio - 0:12",
    });
  });

  it("reports a placed call that never went live", () => {
    const outcome = parseClickToCallOutcome("PLACED_NOT_LIVE");
    expect(outcome.placed).toBe(true);
    expect(outcome.live).toBe(false);
  });

  it("reports an existing live call without placing a second one", () => {
    const outcome = parseClickToCallOutcome("ALREADY_LIVE:FaceTime Audio - 0:41");
    expect(outcome.placed).toBe(false);
    expect(outcome.live).toBe(true);
    expect(outcome.detail).toContain("already live");
  });

  it("reports a missing call button", () => {
    const outcome = parseClickToCallOutcome("NOT_FOUND");
    expect(outcome.placed).toBe(false);
    expect(outcome.live).toBe(false);
    expect(outcome.detail).toBe("NOT_FOUND");
  });

  it("reports empty output as not placed", () => {
    expect(parseClickToCallOutcome("  ").placed).toBe(false);
  });
});

describe("placeClickToCallCarrier", () => {
  it("refuses to place a call when the audio driver is not current", async () => {
    inspectFaceTimeDriver.mockResolvedValue("missing");

    const outcome = await placeClickToCallCarrier({
      runCommandWithTimeout: runCommandWithTimeout as never,
      ownerHandles: ["owner@example.com"],
      handle: "owner@example.com",
      mode: "audio",
      pluginRoot: "/tmp/facetime",
    });

    expect(outcome.placed).toBe(false);
    expect(outcome.detail).toContain("driver is missing");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("refuses a handle that is not an authorized owner handle", async () => {
    await expect(
      placeClickToCallCarrier({
        runCommandWithTimeout: runCommandWithTimeout as never,
        ownerHandles: ["owner@example.com"],
        handle: "stranger@example.com",
        mode: "audio",
        pluginRoot: "/tmp/facetime",
      }),
    ).rejects.toThrow("not an authorized owner handle");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("opens the call URL and presses the click-to-call card", async () => {
    runCommandWithTimeout
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "LIVE:FaceTime Audio - 0:03", stderr: "" });

    const outcome = await placeClickToCallCarrier({
      runCommandWithTimeout: runCommandWithTimeout as never,
      ownerHandles: ["owner@example.com"],
      handle: "owner@example.com",
      mode: "audio",
      pluginRoot: "/tmp/facetime",
    });

    expect(outcome).toEqual({
      placed: true,
      live: true,
      detail: "FaceTime Audio - 0:03",
    });
    expect(runCommandWithTimeout.mock.calls[0]?.[0]).toEqual([
      "/usr/bin/open",
      "facetime-audio://owner%40example.com",
    ]);
    expect(runCommandWithTimeout.mock.calls[1]?.[0]?.[0]).toBe("/usr/bin/osascript");
  });

  it("reports a failed open without pressing the card", async () => {
    runCommandWithTimeout.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "no handler",
    });

    const outcome = await placeClickToCallCarrier({
      runCommandWithTimeout: runCommandWithTimeout as never,
      ownerHandles: ["owner@example.com"],
      handle: "owner@example.com",
      mode: "audio",
      pluginRoot: "/tmp/facetime",
    });

    expect(outcome.placed).toBe(false);
    expect(outcome.detail).toBe("no handler");
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
  });
});
