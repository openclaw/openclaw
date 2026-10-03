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

const { connectionOwnerMocks, runtimeContextMocks } = getConnectionControllerMocks();

let modules!: ControllerTestModules;
let controller!: InstanceType<ControllerTestModules["controller"]["WhatsAppConnectionController"]>;

describe("WhatsApp connection shutdown cancellation", () => {
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

  it("joins pending ownership acquisition before shutdown returns", async () => {
    let resolveOwner = (_lease: { release: () => Promise<void> }) => {};
    connectionOwnerMocks.acquire.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOwner = resolve;
      }),
    );
    const openPromise = controller.openConnection({
      connectionId: "pending-owner",
      createListener: async () => createListenerStub() as never,
    });
    const shutdownPromise = controller.shutdown();

    resolveOwner({ release: connectionOwnerMocks.release });

    await expect(openPromise).rejects.toThrow("controller is shutting down");
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(runtimeContextMocks.register).not.toHaveBeenCalled();
    expect(modules.createWaSocketMock).not.toHaveBeenCalled();
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("cancels handshake setup and closes its socket before shutdown returns", async () => {
    const sock = createSocketWithTransportEmitter();
    modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
    modules.waitForWaConnectionMock.mockReturnValueOnce(new Promise(() => {}));
    const openPromise = controller.openConnection({
      connectionId: "pending-handshake",
      createListener: async () => createListenerStub() as never,
    });
    await vi.waitFor(() => expect(modules.waitForWaConnectionMock).toHaveBeenCalledOnce());

    await expect(controller.shutdown()).resolves.toBeUndefined();
    await expect(openPromise).rejects.toThrow("controller is shutting down");
    expect(sock.end).toHaveBeenCalledOnce();
    expect(runtimeContextMocks.register).toHaveBeenCalledTimes(1);
    expect(runtimeContextMocks.register).toHaveBeenLastCalledWith(
      expect.objectContaining({ capability: "connection-owner-pending" }),
    );
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("does not publish a listener that resolves after setup is cancelled", async () => {
    const sock = createSocketWithTransportEmitter();
    const lateListener = { ...createListenerStub(), close: vi.fn(async () => {}) };
    let resolveListener = (_listener: ReturnType<typeof createListenerStub>) => {};
    const listenerPromise = new Promise<ReturnType<typeof createListenerStub>>((resolve) => {
      resolveListener = resolve;
    });
    modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
    modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    const openPromise = controller.openConnection({
      connectionId: "pending-listener",
      createListener: async () => await listenerPromise,
    });
    await vi.waitFor(() => expect(modules.waitForWaConnectionMock).toHaveBeenCalledOnce());

    await expect(controller.shutdown()).resolves.toBeUndefined();
    await expect(openPromise).rejects.toThrow("controller is shutting down");
    resolveListener(lateListener);
    await listenerPromise;
    await vi.waitFor(() => expect(lateListener.close).toHaveBeenCalledOnce());
    expect(controller.getActiveListener()).toBeNull();
    expect(controller.getCurrentSock()).toBeNull();
    expect(runtimeContextMocks.register).toHaveBeenCalledTimes(1);
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("closes a listener resolved at the setup cancellation boundary", async () => {
    const sock = createSocketWithTransportEmitter();
    const listener = { ...createListenerStub(), close: vi.fn(async () => {}) };
    let shutdownPromise: Promise<void> | undefined;
    modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
    modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    const openPromise = controller.openConnection({
      connectionId: "resolved-listener",
      createListener: async () => {
        queueMicrotask(() => {
          shutdownPromise = controller.shutdown();
        });
        return listener as never;
      },
    });

    await expect(openPromise).rejects.toThrow("controller is shutting down");
    await vi.waitFor(() => expect(shutdownPromise).toBeDefined());
    await shutdownPromise;
    expect(listener.close).toHaveBeenCalledOnce();
    expect(controller.getActiveListener()).toBeNull();
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("settles close and cancels setup when the stop signal is already aborted", async () => {
    const abort = new AbortController();
    const stopReason = new Error("already stopped");
    abort.abort(stopReason);
    const preAbortedController = createTestController(
      modules.controller.WhatsAppConnectionController,
      { abortSignal: abort.signal },
    );

    let ownerAcquireSignal: AbortSignal | undefined;
    connectionOwnerMocks.acquire.mockImplementationOnce(async (_authDir, signal) => {
      ownerAcquireSignal = signal;
      return { release: connectionOwnerMocks.release };
    });

    try {
      const abortPromise = (
        preAbortedController as unknown as { abortPromise?: Promise<"aborted"> }
      ).abortPromise;
      await expect(abortPromise).resolves.toBe("aborted");
      await expect(
        preAbortedController.openConnection({
          connectionId: "conn-pre-aborted",
          createListener: async () => createListenerStub() as never,
        }),
      ).rejects.toThrow("controller is shutting down");

      expect(ownerAcquireSignal?.aborted).toBe(true);
      expect(ownerAcquireSignal?.reason).toBe(stopReason);
      expect(modules.createWaSocketMock).not.toHaveBeenCalled();
    } finally {
      await preAbortedController.shutdown();
    }
  });
});
