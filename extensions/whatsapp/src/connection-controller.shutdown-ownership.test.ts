import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerTestModules } from "./connection-controller.test-helpers.js";
import {
  createListenerStub,
  createSocketWithTransportEmitter,
  createTestController,
  getConnectionControllerMocks,
  loadConnectionControllerTestModules,
  resetConnectionControllerTestMocks,
} from "./connection-controller.test-helpers.js";

const { connectionOwnerMocks } = getConnectionControllerMocks();

let modules!: ControllerTestModules;
let controller!: InstanceType<ControllerTestModules["controller"]["WhatsAppConnectionController"]>;

describe("WhatsApp connection shutdown ownership", () => {
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

  it("releases connection ownership only after the Baileys socket closes", async () => {
    const order: string[] = [];
    let closed = false;
    const sock = {
      end: vi.fn(async () => {
        closed = true;
        order.push("socket-close");
      }),
      ws: {
        close: vi.fn(async () => {
          closed = true;
        }),
        get isClosed() {
          return closed;
        },
      },
    };
    connectionOwnerMocks.release.mockImplementationOnce(async () => {
      order.push("owner-release");
    });
    modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
    modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);

    await controller.openConnection({
      connectionId: "owned-conn",
      createListener: async () => createListenerStub() as never,
    });
    await controller.shutdown();

    expect(order).toEqual(["socket-close", "owner-release"]);
  });

  it("retains connection ownership when socket close cannot be confirmed", async () => {
    let closed = false;
    const sock = {
      end: vi
        .fn()
        .mockRejectedValueOnce(new Error("end failed"))
        .mockImplementationOnce(async () => {
          closed = true;
        }),
      ws: {
        close: vi.fn().mockRejectedValueOnce(new Error("websocket close failed")),
        get isClosed() {
          return closed;
        },
      },
    };
    modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
    modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    await controller.openConnection({
      connectionId: "uncertain-close",
      createListener: async () => createListenerStub() as never,
    });

    await expect(controller.shutdown()).rejects.toThrow("socket close could not be confirmed");
    expect(connectionOwnerMocks.release).not.toHaveBeenCalled();
  });

  it("retains connection ownership until queued credentials drain", async () => {
    let closed = false;
    const sock = {
      end: vi.fn(async () => {
        closed = true;
      }),
      ws: {
        close: vi.fn(async () => {
          closed = true;
        }),
        get isClosed() {
          return closed;
        },
      },
    };
    modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
    modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    modules.waitForCredsSaveQueueWithTimeoutMock
      .mockResolvedValueOnce("timed_out")
      .mockResolvedValueOnce("drained");
    await controller.openConnection({
      connectionId: "pending-creds",
      createListener: async () => createListenerStub() as never,
    });

    await expect(controller.shutdown()).rejects.toThrow("credential persistence did not drain");
    expect(connectionOwnerMocks.release).not.toHaveBeenCalled();
    expect(sock.end).toHaveBeenCalledOnce();
    expect(controller.getActiveListener()).toBeNull();
    expect(controller.getCurrentSock()).toBeNull();

    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("retains connection ownership until a failed release can be retried", async () => {
    const sock = createSocketWithTransportEmitter();
    connectionOwnerMocks.release
      .mockRejectedValueOnce(new Error("owner release failed"))
      .mockResolvedValueOnce(undefined);
    modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
    modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    await controller.openConnection({
      connectionId: "release-retry",
      createListener: async () => createListenerStub() as never,
    });

    await expect(controller.shutdown()).rejects.toThrow("owner release failed");
    expect(controller.getActiveListener()).toBeNull();
    expect(controller.getCurrentSock()).toBeNull();

    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(connectionOwnerMocks.release).toHaveBeenCalledTimes(2);
  });
});
