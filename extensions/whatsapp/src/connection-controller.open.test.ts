import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerTestModules } from "./connection-controller.test-helpers.js";
import {
  createListenerStub,
  createSocketWithTransportEmitter,
  createTestController,
  loadConnectionControllerTestModules,
  resetConnectionControllerTestMocks,
} from "./connection-controller.test-helpers.js";
import { DEFAULT_WHATSAPP_SOCKET_TIMING } from "./socket-timing.js";

let modules!: ControllerTestModules;
let controller!: InstanceType<ControllerTestModules["controller"]["WhatsAppConnectionController"]>;

describe("WhatsAppConnectionController open behavior", () => {
  beforeAll(async () => {
    modules = await loadConnectionControllerTestModules();
  });

  beforeEach(() => {
    resetConnectionControllerTestMocks(modules);
    controller = createTestController(modules.controller.WhatsAppConnectionController);
  });

  afterEach(async () => {
    await controller.shutdown();
  });

  it("closes the socket when open fails before listener creation", async () => {
    const sock = createSocketWithTransportEmitter();
    const createListener = vi.fn();

    modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
    modules.waitForWaConnectionMock.mockRejectedValueOnce(new Error("handshake failed"));

    await expect(
      controller.openConnection({
        connectionId: "conn-1",
        createListener,
      }),
    ).rejects.toThrow("handshake failed");

    expect(createListener).not.toHaveBeenCalled();
    expect(sock.end).toHaveBeenCalledOnce();
    const closeError = sock.end.mock.calls[0]?.[0] as Error | undefined;
    expect(closeError).toBeInstanceOf(Error);
    expect(closeError?.message).toBe("OpenClaw WhatsApp socket close");
    expect(sock.ws.close).not.toHaveBeenCalled();
    expect(controller.socketRef.current).toBeNull();
    expect(controller.getActiveListener()).toBeNull();
  });

  it("falls back to raw websocket close when Baileys end is unavailable", () => {
    const sock = { ws: { close: vi.fn() } };

    modules.controller.closeWaSocket(sock);

    expect(sock.ws.close).toHaveBeenCalledOnce();
  });

  it("keeps asynchronous fallback close failures best-effort", async () => {
    const sock = {
      end: vi.fn().mockRejectedValue(new Error("end failed")),
      ws: { close: vi.fn(() => Promise.reject(new Error("websocket close failed"))) },
    };

    modules.controller.closeWaSocket(sock);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(sock.end).toHaveBeenCalledOnce();
    expect(sock.ws.close).toHaveBeenCalledOnce();
  });

  it("lets createWaSocket own the auth barrier before opening a socket", async () => {
    const callOrder: string[] = [];
    modules.createWaSocketMock.mockImplementationOnce(async () => {
      callOrder.push("create");
      return createSocketWithTransportEmitter() as never;
    });
    modules.waitForWaConnectionMock.mockImplementationOnce(async () => {
      callOrder.push("wait-for-connection");
    });

    await controller.openConnection({
      connectionId: "conn-flush-first",
      createListener: async () => createListenerStub() as never,
    });

    expect(callOrder).toEqual(["create", "wait-for-connection"]);
    expect(modules.waitForWaConnectionMock).toHaveBeenCalledWith(expect.anything(), {
      timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
    });
  });
});
