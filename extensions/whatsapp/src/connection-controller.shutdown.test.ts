// Whatsapp tests cover connection controller shutdown and exclusive-owner cleanup.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppConnectionController } from "./connection-controller.js";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import {
  createWaSocket,
  waitForCredsSaveQueueWithTimeout,
  waitForWaConnection,
} from "./session.js";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    ...actual,
    createWaSocket: vi.fn(),
    waitForWaConnection: vi.fn(),
    waitForCredsSaveQueueWithTimeout: vi.fn(async () => "drained" as const),
  };
});

const runtimeContextMocks = vi.hoisted(() => ({
  channelRuntime: { runtimeContexts: {} },
  register: vi.fn(),
}));

const connectionOwnerMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  setCleanupRetry: vi.fn(),
}));

// mock-isolation: runtime context registrations must not leak between controller instances.
vi.mock("openclaw/plugin-sdk/channel-runtime-context", () => {
  return {
    getChannelRuntimeContext: vi.fn(),
    registerChannelRuntimeContext: runtimeContextMocks.register,
  };
});

// mock-isolation: no plugin runtime is booted; the controller only needs the context registry handle.
vi.mock("./runtime.js", () => ({
  getWhatsAppChannelRuntime: () => runtimeContextMocks.channelRuntime,
}));

// mock-isolation: observe release ordering and retry hand-off without real lock files.
vi.mock("./connection-owner.js", () => ({
  acquireWhatsAppGatewayConnectionOwner: connectionOwnerMocks.acquire,
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const waitForCredsSaveQueueWithTimeoutMock = vi.mocked(waitForCredsSaveQueueWithTimeout);
const registerChannelRuntimeContextMock = runtimeContextMocks.register;

function createListenerStub(messageId = "ok") {
  return {
    sendMessage: vi.fn(async () => createAcceptedWhatsAppSendResult("text", messageId)),
    sendPoll: vi.fn(async () => createAcceptedWhatsAppSendResult("poll", messageId)),
    sendReaction: vi.fn(async () => createAcceptedWhatsAppSendResult("reaction", messageId)),
    sendComposingTo: vi.fn(async () => {}),
  };
}

function createSocketWithTransportEmitter() {
  let closed = false;
  const ws = new EventEmitter() as EventEmitter & {
    close: ReturnType<typeof vi.fn>;
    readonly isClosed: boolean;
  };
  Object.defineProperty(ws, "isClosed", { get: () => closed });
  ws.close = vi.fn(async () => {
    closed = true;
  });
  return {
    end: vi.fn(async (_error?: Error) => {
      closed = true;
    }),
    ws,
  };
}

describe("WhatsAppConnectionController shutdown", () => {
  let controller: WhatsAppConnectionController;

  beforeEach(() => {
    vi.clearAllMocks();
    registerChannelRuntimeContextMock.mockReturnValue({ dispose: vi.fn() });
    connectionOwnerMocks.acquire.mockResolvedValue({
      release: connectionOwnerMocks.release,
      setCleanupRetry: connectionOwnerMocks.setCleanupRetry,
    });
    connectionOwnerMocks.release.mockResolvedValue(undefined);
    waitForCredsSaveQueueWithTimeoutMock.mockReset().mockResolvedValue("drained");
    controller = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      transportTimeoutMs: 60_000,
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
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);

    await controller.openConnection({
      connectionId: "owned-conn",
      createListener: async () => createListenerStub() as never,
    });
    await controller.shutdown();

    expect(order).toEqual(["socket-close", "owner-release"]);
  });

  it("joins pending ownership acquisition before shutdown returns", async () => {
    let resolveOwner = (_lease: {
      release: () => Promise<void>;
      setCleanupRetry: (retry: () => Promise<void>) => void;
    }) => {};
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

    resolveOwner({
      release: connectionOwnerMocks.release,
      setCleanupRetry: connectionOwnerMocks.setCleanupRetry,
    });

    await expect(openPromise).rejects.toThrow("controller is shutting down");
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(registerChannelRuntimeContextMock).not.toHaveBeenCalled();
    expect(createWaSocketMock).not.toHaveBeenCalled();
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("cancels handshake setup and closes its socket before shutdown returns", async () => {
    const sock = createSocketWithTransportEmitter();
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockReturnValueOnce(new Promise(() => {}));
    const openPromise = controller.openConnection({
      connectionId: "pending-handshake",
      createListener: async () => createListenerStub() as never,
    });
    await vi.waitFor(() => expect(waitForWaConnectionMock).toHaveBeenCalledOnce());

    await expect(controller.shutdown()).resolves.toBeUndefined();
    await expect(openPromise).rejects.toThrow("controller is shutting down");
    expect(sock.end).toHaveBeenCalledOnce();
    expect(registerChannelRuntimeContextMock).toHaveBeenCalledTimes(1);
    expect(registerChannelRuntimeContextMock).toHaveBeenLastCalledWith(
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
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    const openPromise = controller.openConnection({
      connectionId: "pending-listener",
      createListener: async () => await listenerPromise,
    });
    await vi.waitFor(() => expect(waitForWaConnectionMock).toHaveBeenCalledOnce());

    await expect(controller.shutdown()).resolves.toBeUndefined();
    await expect(openPromise).rejects.toThrow("controller is shutting down");
    resolveListener(lateListener);
    await listenerPromise;
    await vi.waitFor(() => expect(lateListener.close).toHaveBeenCalledOnce());
    expect(controller.getActiveListener()).toBeNull();
    expect(controller.getCurrentSock()).toBeNull();
    expect(registerChannelRuntimeContextMock).toHaveBeenCalledTimes(1);
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("closes a listener resolved at the setup cancellation boundary", async () => {
    const sock = createSocketWithTransportEmitter();
    const listener = { ...createListenerStub(), close: vi.fn(async () => {}) };
    let shutdownPromise: Promise<void> | undefined;
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
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
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
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
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    waitForCredsSaveQueueWithTimeoutMock
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

  it("lets a replacement finish a failed cleanup through the owner lease", async () => {
    const sock = createSocketWithTransportEmitter();
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    waitForCredsSaveQueueWithTimeoutMock
      .mockResolvedValueOnce("timed_out")
      .mockResolvedValueOnce("drained");
    await controller.openConnection({
      connectionId: "owner-retry",
      createListener: async () => createListenerStub() as never,
    });
    expect(connectionOwnerMocks.setCleanupRetry).toHaveBeenCalledOnce();
    const [retry] = connectionOwnerMocks.setCleanupRetry.mock.calls[0] as [() => Promise<void>];

    // A replacement that arrives while the owner is healthy must not stop it.
    await expect(retry()).resolves.toBeUndefined();
    expect(sock.end).not.toHaveBeenCalled();
    expect(connectionOwnerMocks.release).not.toHaveBeenCalled();

    await expect(controller.shutdown()).rejects.toThrow("credential persistence did not drain");
    expect(connectionOwnerMocks.release).not.toHaveBeenCalled();

    await expect(retry()).resolves.toBeUndefined();
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("runs concurrent shutdowns once and allows a retry after failure", async () => {
    const sock = createSocketWithTransportEmitter();
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    waitForCredsSaveQueueWithTimeoutMock
      .mockResolvedValueOnce("timed_out")
      .mockResolvedValueOnce("drained");
    await controller.openConnection({
      connectionId: "single-flight",
      createListener: async () => createListenerStub() as never,
    });

    const first = controller.shutdown();
    const second = controller.shutdown();
    await expect(first).rejects.toThrow("credential persistence did not drain");
    await expect(second).rejects.toThrow("credential persistence did not drain");
    expect(sock.end).toHaveBeenCalledOnce();

    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("retains connection ownership until a failed release can be retried", async () => {
    const sock = createSocketWithTransportEmitter();
    connectionOwnerMocks.release
      .mockRejectedValueOnce(new Error("owner release failed"))
      .mockResolvedValueOnce(undefined);
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
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
