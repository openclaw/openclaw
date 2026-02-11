import { describe, expect, it } from "vitest";
import { isMonitoredStream } from "./monitor-helpers.js";

describe("isMonitoredStream", () => {
  it("allows when monitoredStreams is empty", () => {
    expect(isMonitoredStream({ monitoredStreams: [], streamName: "general", streamId: "3" })).toBe(
      true,
    );
  });

  it("allows when monitoredStreams includes '*'", () => {
    expect(
      isMonitoredStream({ monitoredStreams: ["*"], streamName: "general", streamId: "3" }),
    ).toBe(true);
  });

  it("matches by stream name (case-insensitive)", () => {
    expect(
      isMonitoredStream({ monitoredStreams: ["General"], streamName: "general", streamId: "3" }),
    ).toBe(true);
    expect(
      isMonitoredStream({ monitoredStreams: ["general"], streamName: "GENERAL", streamId: "3" }),
    ).toBe(true);
  });

  it("matches by stream id when name is unavailable", () => {
    expect(isMonitoredStream({ monitoredStreams: ["5"], streamName: "", streamId: "5" })).toBe(
      true,
    );
  });

  it("rejects when stream is not monitored", () => {
    expect(
      isMonitoredStream({
        monitoredStreams: ["build", "openclaw"],
        streamName: "research",
        streamId: "6",
      }),
    ).toBe(false);
  });
});
