import { beforeEach, describe, expect, it } from "vitest";
import { createWebChannelStatusController } from "./monitor-state.js";

describe("createWebChannelStatusController", () => {
  let patches: Record<string, unknown>[];
  let controller: ReturnType<typeof createWebChannelStatusController>;
  beforeEach(() => {
    patches = [];
    controller = createWebChannelStatusController((s) => patches.push({ ...s }));
    controller.noteConnected(1000);
  });

  it("updates lastTransportActivityAt on noteInbound", () => {
    controller.noteInbound(2000);
    expect(patches.at(-1)!.lastTransportActivityAt).toBe(2000);
  });

  it("publishes heartbeat auth age even when transport activity stays unchanged", () => {
    for (const authAgeMs of [5000, 1000, null]) {
      controller.noteTransportActivity(3000, authAgeMs);
      expect(patches.at(-1)).toMatchObject({ lastTransportActivityAt: 3000, authAgeMs });
    }
  });

  it("publishes busy state for pending inbound work", () => {
    controller.noteBusy(true, 2000);
    controller.noteBusy(false, 3000);

    expect(patches.at(-2)).toMatchObject({
      busy: true,
      lastRunActivityAt: 2000,
      healthState: "healthy",
    });
    expect(patches.at(-1)).toMatchObject({ busy: false, lastRunActivityAt: 3000 });
  });

  it("does not set lastTransportActivityAt on noteWatchdogStale", () => {
    controller.noteWatchdogStale(5000);

    expect(patches.at(-1)).toMatchObject({
      lastTransportActivityAt: 1000,
      healthState: "stale",
      lifecycle: "recovering",
    });
  });

  it("clears watchdog recovery history once the socket is healthy again", () => {
    controller.noteClose({
      at: 2000,
      statusCode: 499,
      error: "status=499",
      reconnectAttempts: 1,
      healthState: "reconnecting",
      watchdogRecovery: true,
    });
    expect(patches.at(-1)!.lastDisconnect).toEqual({
      at: 2000,
      status: 499,
      error: "status=499",
      loggedOut: false,
    });
    controller.noteConnected(3000);

    expect(patches.at(-1)).toMatchObject({
      connected: true,
      healthState: "healthy",
      reconnectAttempts: 0,
      lastDisconnect: null,
    });
  });

  it("keeps non-watchdog reconnect history after the socket reconnects", () => {
    controller.noteClose({
      at: 2000,
      statusCode: 408,
      error: "status=408",
      reconnectAttempts: 1,
      healthState: "reconnecting",
    });
    controller.noteConnected(3000);

    expect(patches.at(-1)).toMatchObject({
      connected: true,
      healthState: "healthy",
      reconnectAttempts: 1,
    });
    expect(patches.at(-1)!.lastDisconnect).toEqual({
      at: 2000,
      status: 408,
      error: "status=408",
      loggedOut: false,
    });
  });

  it("publishes stopped lifecycle after a reconnecting stop", () => {
    const error = "WhatsApp connection timed out";
    controller.noteClose({
      at: 2000,
      statusCode: 408,
      error,
      reconnectAttempts: 1,
      healthState: "reconnecting",
    });
    expect(patches.at(-1)).toMatchObject({ healthState: "reconnecting", lifecycle: "recovering" });

    const stoppedStatus = {
      healthState: "stopped",
      lifecycle: "stopped",
      terminalDisconnect: false,
      lastError: error,
      reconnectAttempts: 1,
      lastDisconnect: {
        at: 2000,
        status: 408,
        error,
      },
    };

    controller.markStopped(2100);
    expect(patches.at(-1)).toMatchObject(stoppedStatus);

    controller.markStopped(2200);
    expect(patches.at(-1)).toMatchObject(stoppedStatus);
  });

  it("clears terminalDisconnect on reconnect after a logged-out stop", () => {
    controller.noteClose({
      at: 2000,
      statusCode: 401,
      error: "logged-out",
      reconnectAttempts: 0,
      healthState: "logged-out",
    });
    controller.markStopped(2100);
    expect(patches.at(-1)).toMatchObject({ terminalDisconnect: true, lifecycle: "blocked" });

    controller.markStopped(2200);
    expect(patches.at(-1)).toMatchObject({ terminalDisconnect: true, lifecycle: "blocked" });

    controller.noteConnected(3000);
    expect(patches.at(-1)!.terminalDisconnect).toBeUndefined();
    expect(patches.at(-1)).toMatchObject({ healthState: "healthy", lifecycle: "ready" });

    controller.markStopped(3100);
    expect(patches.at(-1)).toMatchObject({
      healthState: "stopped",
      lifecycle: "stopped",
      terminalDisconnect: false,
    });

    controller.markStopped(3200);
    expect(patches.at(-1)).toMatchObject({
      healthState: "stopped",
      lifecycle: "stopped",
      terminalDisconnect: false,
    });
  });
});
