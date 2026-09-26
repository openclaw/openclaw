import { describe, expect, it, vi } from "vitest";
import {
  publishMSTeamsBlocked,
  publishMSTeamsReady,
  publishMSTeamsStopped,
} from "./monitor-status.js";

describe("Microsoft Teams monitor status", () => {
  it("publishes blocked, ready, and stopped lifecycle patches", () => {
    const statusSink = vi.fn();
    publishMSTeamsBlocked(statusSink, "credentials missing");
    publishMSTeamsReady(statusSink, 42);
    publishMSTeamsStopped(statusSink);

    expect(statusSink.mock.calls.map(([patch]) => patch)).toEqual([
      expect.objectContaining({ lifecycle: "blocked", terminalDisconnect: true }),
      expect.objectContaining({
        lifecycle: "ready",
        connected: true,
        lastConnectedAt: 42,
        terminalDisconnect: undefined,
      }),
      expect.objectContaining({ lifecycle: "stopped", running: false }),
    ]);
  });
});
