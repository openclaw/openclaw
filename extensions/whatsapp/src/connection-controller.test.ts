import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import { WhatsAppConnectionController } from "./connection-controller.js";
import { createWaSocket, waitForWaConnection } from "./session.js";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    ...actual,
    createWaSocket: vi.fn(),
    waitForWaConnection: vi.fn(),
  };
});

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);

describe("WhatsAppConnectionController", () => {
  let controller: WhatsAppConnectionController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });
  });

  afterEach(async () => {
    await controller.shutdown();
  });

  it("closes the socket when open fails before listener creation", async () => {
    const sock = {
      ws: {
        close: vi.fn(),
      },
    };
    const createListener = vi.fn();

    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockRejectedValueOnce(new Error("handshake failed"));

    await expect(
      controller.openConnection({
        connectionId: "conn-1",
        createListener,
      }),
    ).rejects.toThrow("handshake failed");

    expect(createListener).not.toHaveBeenCalled();
    expect(sock.ws.close).toHaveBeenCalledOnce();
    expect(controller.socketRef.current).toBeNull();
    expect(controller.getActiveListener()).toBeNull();
  });

  it("keeps the previous registered controller until a replacement listener is ready", async () => {
    const liveController = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });
    const liveListener = {
      sendMessage: vi.fn(async () => ({ messageId: "live-msg" })),
      sendPoll: vi.fn(async () => ({ messageId: "live-poll" })),
      sendReaction: vi.fn(async () => {}),
      sendComposingTo: vi.fn(async () => {}),
    };
    createWaSocketMock.mockResolvedValueOnce({ ws: { close: vi.fn() } } as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    await liveController.openConnection({
      connectionId: "live-conn",
      createListener: async () => liveListener,
    });

    expect(getRegisteredWhatsAppConnectionController("work")).toBe(liveController);

    const replacement = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth-2",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });

    try {
      createWaSocketMock.mockResolvedValueOnce({ ws: { close: vi.fn() } } as never);
      waitForWaConnectionMock.mockRejectedValueOnce(new Error("replacement failed"));

      await expect(
        replacement.openConnection({
          connectionId: "replacement-conn",
          createListener: async () => liveListener,
        }),
      ).rejects.toThrow("replacement failed");

      expect(getRegisteredWhatsAppConnectionController("work")).toBe(liveController);
    } finally {
      await replacement.shutdown();
      await liveController.shutdown();
    }
  });

  it("starts reconnect safety timer on close and clears on reopen", async () => {
    vi.useFakeTimers();
    try {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const sock = { ws: { close: vi.fn() } };
      const listener = {
        sendMessage: vi.fn(async () => ({ messageId: "m1" })),
        sendPoll: vi.fn(async () => ({ messageId: "p1" })),
        sendReaction: vi.fn(async () => {}),
        sendComposingTo: vi.fn(async () => {}),
      };
      createWaSocketMock.mockResolvedValueOnce(sock as never);
      waitForWaConnectionMock.mockResolvedValueOnce(undefined);
      await controller.openConnection({
        connectionId: "conn-guard",
        createListener: async () => listener,
      });

      // Close the connection — safety timer should start
      await controller.closeCurrentConnection();

      // Advance past the safety timeout
      await vi.advanceTimersByTimeAsync(91_000);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("reconnect may be stuck"));

      warnSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears reconnect safety timer when new connection opens", async () => {
    vi.useFakeTimers();
    try {
      const infoSpy = vi.spyOn(await import("openclaw/plugin-sdk/runtime-env"), "info");
      const sock = { ws: { close: vi.fn() } };
      const listener = {
        sendMessage: vi.fn(async () => ({ messageId: "m1" })),
        sendPoll: vi.fn(async () => ({ messageId: "p1" })),
        sendReaction: vi.fn(async () => {}),
        sendComposingTo: vi.fn(async () => {}),
      };

      createWaSocketMock.mockResolvedValue(sock as never);
      waitForWaConnectionMock.mockResolvedValue(undefined);

      await controller.openConnection({
        connectionId: "conn-1",
        createListener: async () => listener,
      });
      await controller.closeCurrentConnection();

      // Reopen before safety timer fires
      await controller.openConnection({
        connectionId: "conn-2",
        createListener: async () => listener,
      });

      // Advance past the safety timeout — timer should have been cleared
      await vi.advanceTimersByTimeAsync(91_000);
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining("reconnect may be stuck"));

      infoSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears reconnect safety timer on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const infoSpy = vi.spyOn(await import("openclaw/plugin-sdk/runtime-env"), "info");
      const sock = { ws: { close: vi.fn() } };
      const listener = {
        sendMessage: vi.fn(async () => ({ messageId: "m1" })),
        sendPoll: vi.fn(async () => ({ messageId: "p1" })),
        sendReaction: vi.fn(async () => {}),
        sendComposingTo: vi.fn(async () => {}),
      };

      createWaSocketMock.mockResolvedValueOnce(sock as never);
      waitForWaConnectionMock.mockResolvedValueOnce(undefined);

      await controller.openConnection({
        connectionId: "conn-shutdown",
        createListener: async () => listener,
      });
      await controller.closeCurrentConnection();
      await controller.shutdown();

      // Advance past the safety timeout — timer should have been cleared by shutdown
      await vi.advanceTimersByTimeAsync(91_000);
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining("reconnect may be stuck"));

      infoSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
