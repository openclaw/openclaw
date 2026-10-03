import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerTestModules } from "./connection-controller.test-helpers.js";
import {
  createListenerStub,
  createSocketWithTransportEmitter,
  createTestController,
  loadConnectionControllerTestModules,
  resetConnectionControllerTestMocks,
} from "./connection-controller.test-helpers.js";

let modules!: ControllerTestModules;

describe("WhatsApp connection watchdog", () => {
  beforeAll(async () => {
    modules = await loadConnectionControllerTestModules();
  });

  beforeEach(() => {
    resetConnectionControllerTestMocks(modules);
  });

  it("tracks real websocket frame activity in the connection snapshot", async () => {
    vi.useFakeTimers();
    const controller = createTestController(modules.controller.WhatsAppConnectionController, {
      keepAlive: true,
      heartbeatSeconds: 1,
    });

    try {
      const sock = createSocketWithTransportEmitter();
      modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
      modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);

      const snapshots: Array<{ lastTransportActivityAt: number }> = [];
      await controller.openConnection({
        connectionId: "conn-frame-activity",
        createListener: async () => createListenerStub() as never,
        onHeartbeat: (snapshot) => snapshots.push(snapshot),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const firstSnapshot = snapshots.at(-1);
      expect(firstSnapshot?.lastTransportActivityAt).toBeTypeOf("number");

      const firstTransportAt = firstSnapshot?.lastTransportActivityAt ?? 0;
      await vi.advanceTimersByTimeAsync(250);
      sock.ws.emit("frame");
      await vi.advanceTimersByTimeAsync(1_000);

      const lastSnapshot = snapshots.at(-1);
      expect(lastSnapshot?.lastTransportActivityAt).toBeGreaterThan(firstTransportAt);
    } finally {
      await controller.shutdown();
      vi.useRealTimers();
    }
  });

  it("forces reconnect on transport stall before the long app-silence window", async () => {
    vi.useFakeTimers();
    const controller = createTestController(modules.controller.WhatsAppConnectionController, {
      keepAlive: true,
      heartbeatSeconds: 1,
      transportTimeoutMs: 30,
      messageTimeoutMs: 3_000,
      watchdogCheckMs: 5,
    });

    try {
      const sock = createSocketWithTransportEmitter();
      modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
      modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);

      const timeouts: string[] = [];
      await controller.openConnection({
        connectionId: "conn-transport-timeout",
        createListener: async () => createListenerStub() as never,
        onWatchdogTimeout: () => timeouts.push("timeout"),
      });

      await vi.advanceTimersByTimeAsync(40);

      expect(timeouts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await controller.shutdown();
      vi.useRealTimers();
    }
  });

  it("uses messageTimeoutMs * 4 as the app-silence window for fresh connections with no inbound", async () => {
    // Verifies the watchdog respects appSilenceTimeoutMs = messageTimeoutMs * 4 on first open.
    // Transport is kept well within its own timeout so only app-silence fires.
    vi.useFakeTimers();
    const msgTimeoutMs = 100;
    const controller = createTestController(modules.controller.WhatsAppConnectionController, {
      keepAlive: true,
      heartbeatSeconds: 1,
      transportTimeoutMs: 10_000,
      messageTimeoutMs: msgTimeoutMs,
      watchdogCheckMs: 10,
    });

    try {
      const sock = createSocketWithTransportEmitter();
      modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
      modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);

      const timeouts: string[] = [];
      await controller.openConnection({
        connectionId: "conn-app-silence",
        createListener: async () => createListenerStub() as never,
        onWatchdogTimeout: () => timeouts.push("timeout"),
      });

      // Just before messageTimeoutMs * 4 — no force-close expected
      await vi.advanceTimersByTimeAsync(msgTimeoutMs * 4 - 20);
      expect(timeouts).toHaveLength(0);

      // Past messageTimeoutMs * 4 — force-close must fire
      await vi.advanceTimersByTimeAsync(40);
      expect(timeouts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await controller.shutdown();
      vi.useRealTimers();
    }
  });
});
