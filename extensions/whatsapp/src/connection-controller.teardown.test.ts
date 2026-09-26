// Whatsapp tests cover bounded last-route teardown during connection close.
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
    logoutWeb: vi.fn(async () => true),
    readWebAuthExistsForDecision: vi.fn(async () => ({ outcome: "stable" as const, exists: true })),
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
}));

vi.mock("openclaw/plugin-sdk/channel-runtime-context", () => ({
  getChannelRuntimeContext: vi.fn(),
  registerChannelRuntimeContext: runtimeContextMocks.register,
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppChannelRuntime: () => runtimeContextMocks.channelRuntime,
}));

vi.mock("./connection-owner.js", () => ({
  acquireWhatsAppGatewayConnectionOwner: connectionOwnerMocks.acquire,
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const waitForCredsSaveQueueWithTimeoutMock = vi.mocked(waitForCredsSaveQueueWithTimeout);

function createListenerStub() {
  return {
    sendMessage: vi.fn(async () => createAcceptedWhatsAppSendResult("text", "ok")),
    sendPoll: vi.fn(async () => createAcceptedWhatsAppSendResult("poll", "ok")),
    sendReaction: vi.fn(async () => createAcceptedWhatsAppSendResult("reaction", "ok")),
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

describe("WhatsAppConnectionController last-route teardown", () => {
  let controller: WhatsAppConnectionController;

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeContextMocks.register.mockReturnValue({ dispose: vi.fn() });
    connectionOwnerMocks.acquire.mockResolvedValue({ release: connectionOwnerMocks.release });
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

  it(
    "does not hang reconnect teardown on a stuck last-route write",
    { timeout: 5_000 },
    async () => {
      vi.useFakeTimers();
      const sock = createSocketWithTransportEmitter();
      createWaSocketMock.mockResolvedValueOnce(sock as never);
      waitForWaConnectionMock.mockResolvedValueOnce(undefined);
      const connection = await controller.openConnection({
        connectionId: "stuck-last-route",
        createListener: async () => createListenerStub() as never,
      });
      connection.backgroundTasks.add(new Promise(() => {}));

      try {
        const closeTask = controller.closeCurrentConnection();
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(closeTask).resolves.toBeUndefined();
        expect(controller.getActiveListener()).toBeNull();
        expect(controller.getCurrentSock()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "keeps a drain window during shutdown even after setup abort",
    { timeout: 5_000 },
    async () => {
      vi.useFakeTimers();
      const sock = createSocketWithTransportEmitter();
      createWaSocketMock.mockResolvedValueOnce(sock as never);
      waitForWaConnectionMock.mockResolvedValueOnce(undefined);
      const connection = await controller.openConnection({
        connectionId: "shutdown-stuck-last-route",
        createListener: async () => createListenerStub() as never,
      });
      connection.backgroundTasks.add(new Promise(() => {}));

      try {
        const shutdownTask = controller.shutdown();
        let settled = false;
        void shutdownTask.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(14_000);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(shutdownTask).resolves.toBeUndefined();
        expect(settled).toBe(true);
        expect(controller.getActiveListener()).toBeNull();
        expect(controller.getCurrentSock()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("lets a slow last-route write finish during shutdown", { timeout: 5_000 }, async () => {
    vi.useFakeTimers();
    const sock = createSocketWithTransportEmitter();
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    const connection = await controller.openConnection({
      connectionId: "shutdown-slow-last-route",
      createListener: async () => createListenerStub() as never,
    });
    let persisted = false;
    connection.backgroundTasks.add(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          persisted = true;
          resolve();
        }, 200);
      }),
    );

    try {
      const shutdownTask = controller.shutdown();
      await vi.advanceTimersByTimeAsync(200);
      await expect(shutdownTask).resolves.toBeUndefined();
      expect(persisted).toBe(true);
      expect(controller.getActiveListener()).toBeNull();
      expect(controller.getCurrentSock()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it(
    "does not hang reconnect teardown while opening a replacement socket",
    { timeout: 5_000 },
    async () => {
      vi.useFakeTimers();
      const firstSock = createSocketWithTransportEmitter();
      const secondSock = createSocketWithTransportEmitter();
      createWaSocketMock
        .mockResolvedValueOnce(firstSock as never)
        .mockResolvedValueOnce(secondSock as never);
      waitForWaConnectionMock.mockResolvedValue(undefined);
      const connection = await controller.openConnection({
        connectionId: "reconnect-stuck-last-route",
        createListener: async () => createListenerStub() as never,
      });
      connection.backgroundTasks.add(new Promise(() => {}));

      try {
        const reopenTask = controller.openConnection({
          connectionId: "reconnect-replacement",
          createListener: async () => createListenerStub() as never,
        });
        let reopened = false;
        void reopenTask.then(() => {
          reopened = true;
        });
        await vi.advanceTimersByTimeAsync(14_000);
        expect(reopened).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(reopenTask).resolves.toMatchObject({
          connectionId: "reconnect-replacement",
        });
        expect(reopened).toBe(true);
        expect(controller.getCurrentSock()).toBe(secondSock);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
