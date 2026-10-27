import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DisconnectReason } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeWaSocket,
  waitForWhatsAppLoginResult,
  WhatsAppConnectionController,
} from "./connection-controller.js";
import { enqueueCredsSave, writeCredsJsonAtomically } from "./creds-persistence.js";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import {
  createWaSocket,
  logoutWeb,
  readWebAuthExistsForDecision,
  waitForCredsSaveQueueWithTimeout,
  waitForWaConnection,
} from "./session.js";
import { DEFAULT_WHATSAPP_SOCKET_TIMING } from "./socket-timing.js";

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

vi.mock("openclaw/plugin-sdk/channel-runtime-context", () => {
  return {
    getChannelRuntimeContext: vi.fn(),
    registerChannelRuntimeContext: runtimeContextMocks.register,
  };
});

vi.mock("./runtime.js", () => ({
  getWhatsAppChannelRuntime: () => runtimeContextMocks.channelRuntime,
}));

vi.mock("./connection-owner.js", () => ({
  acquireWhatsAppGatewayConnectionOwner: connectionOwnerMocks.acquire,
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const logoutWebMock = vi.mocked(logoutWeb);
const readWebAuthExistsForDecisionMock = vi.mocked(readWebAuthExistsForDecision);
const waitForCredsSaveQueueWithTimeoutMock = vi.mocked(waitForCredsSaveQueueWithTimeout);
const registerChannelRuntimeContextMock = runtimeContextMocks.register;

function createController(
  overrides: Partial<ConstructorParameters<typeof WhatsAppConnectionController>[0]> = {},
) {
  return new WhatsAppConnectionController({
    accountId: "work",
    authDir: "/tmp/wa-auth",
    verbose: false,
    keepAlive: false,
    heartbeatSeconds: 30,
    transportTimeoutMs: 60_000,
    messageTimeoutMs: 60_000,
    watchdogCheckMs: 5_000,
    reconnectPolicy: { initialMs: 250, maxMs: 1_000, factor: 2, jitter: 0, maxAttempts: 5 },
    ...overrides,
  });
}

function createListenerStub(messageId = "ok") {
  return {
    sendMessage: vi.fn(async () => createAcceptedWhatsAppSendResult("text", messageId)),
    sendPoll: vi.fn(async () => createAcceptedWhatsAppSendResult("poll", messageId)),
    sendReaction: vi.fn(async () => createAcceptedWhatsAppSendResult("reaction", messageId)),
    sendComposingTo: vi.fn(async () => {}),
  };
}

function createSocketWithTransportEmitter(onEnd = () => {}) {
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
      onEnd();
    }),
    ws,
  };
}

function queueConnectedSocket(sock: unknown = createSocketWithTransportEmitter()) {
  createWaSocketMock.mockResolvedValueOnce(sock as never);
  waitForWaConnectionMock.mockResolvedValueOnce(undefined);
}

function expectLoginWaits(
  wait: ReturnType<typeof vi.fn>,
  ...sockets: ReturnType<typeof createSocketWithTransportEmitter>[]
) {
  expect(wait.mock.calls).toEqual(sockets.map((sock) => [sock, { timeout: "none" }]));
}

const loginAuthDir = "/tmp/wa-auth";

function createLoginResultHarness() {
  const initialSock = createSocketWithTransportEmitter();
  const replacementSock = createSocketWithTransportEmitter();
  const runtime = { log: vi.fn() } as never;

  return {
    initialSock,
    replacementSock,
    runtime,
    run: (
      opts: Omit<Partial<Parameters<typeof waitForWhatsAppLoginResult>[0]>, "waitForConnection"> & {
        waitForConnection: ReturnType<typeof vi.fn>;
      },
    ) =>
      waitForWhatsAppLoginResult({
        sock: initialSock as never,
        authDir: loginAuthDir,
        isLegacyAuthDir: false,
        verbose: false,
        runtime,
        ...opts,
        waitForConnection: opts.waitForConnection as never,
      }),
  };
}

describe("WhatsAppConnectionController", () => {
  let controller: WhatsAppConnectionController;

  const open = (connectionId: string, owner = controller) =>
    owner.openConnection({
      connectionId,
      createListener: async () => createListenerStub() as never,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    createWaSocketMock.mockReset();
    registerChannelRuntimeContextMock.mockReturnValue({ dispose: vi.fn() });
    connectionOwnerMocks.acquire.mockResolvedValue({ release: connectionOwnerMocks.release });
    connectionOwnerMocks.release.mockResolvedValue(undefined);
    logoutWebMock.mockResolvedValue(true);
    readWebAuthExistsForDecisionMock
      .mockReset()
      .mockResolvedValue({ outcome: "stable", exists: true });
    waitForCredsSaveQueueWithTimeoutMock.mockReset().mockResolvedValue("drained");
    controller = createController();
  });

  afterEach(async () => {
    await controller.shutdown();
  });

  it("closes the socket when open fails before listener creation", async () => {
    const sock = createSocketWithTransportEmitter();
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
    expect(waitForWaConnectionMock).toHaveBeenCalledWith(sock, {
      timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
    });
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

    closeWaSocket(sock);

    expect(sock.ws.close).toHaveBeenCalledOnce();
  });

  it("keeps asynchronous fallback close failures best-effort", async () => {
    const sock = {
      end: vi.fn().mockRejectedValue(new Error("end failed")),
      ws: { close: vi.fn(() => Promise.reject(new Error("websocket close failed"))) },
    };

    closeWaSocket(sock);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(sock.end).toHaveBeenCalledOnce();
    expect(sock.ws.close).toHaveBeenCalledOnce();
  });

  it("preserves socket options and guards through 408 recovery then post-pairing 515 restart", async () => {
    const harness = createLoginResultHarness();
    const afterTimeoutSock = createSocketWithTransportEmitter();
    const afterPairingRestartSock = createSocketWithTransportEmitter();
    const onQr = vi.fn();
    const onSocketReplaced = vi.fn();
    const beforeCredentialPersistence = vi.fn(async () => {});
    const onCredentialPersistenceError = vi.fn();
    const onCredentialPersistenceTask = vi.fn();
    const waitForCredentialPersistence = vi.fn(async () => {});
    const socketTiming = {
      connectTimeoutMs: 10_000,
      defaultQueryTimeoutMs: 20_000,
      keepAliveIntervalMs: 30_000,
    };
    const waitForConnection = vi
      .fn()
      .mockRejectedValueOnce({ output: { statusCode: DisconnectReason.timedOut } })
      .mockRejectedValueOnce({ output: { statusCode: 515 } })
      .mockResolvedValueOnce(undefined);
    const createSocket = createWaSocketMock
      .mockImplementationOnce(async (_printQr, _verbose, opts) => {
        opts?.onQr?.("replacement-qr");
        return afterTimeoutSock as never;
      })
      .mockResolvedValueOnce(afterPairingRestartSock as never);

    const result = await harness.run({
      verbose: true,
      waitForConnection,
      socketTiming,
      onQr,
      onSocketReplaced,
      beforeCredentialPersistence,
      onCredentialPersistenceError,
      onCredentialPersistenceTask,
      waitForCredentialPersistence,
    });

    expect(result).toEqual({
      outcome: "connected",
      restarted: true,
      sock: afterPairingRestartSock,
    });
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(createSocket).toHaveBeenNthCalledWith(2, false, true, {
      authDir: loginAuthDir,
      ...socketTiming,
      onQr,
      beforeCredentialPersistence,
      onCredentialPersistenceError,
      onCredentialPersistenceTask,
    });
    expect(onQr).toHaveBeenCalledWith("replacement-qr");
    expect(onSocketReplaced.mock.calls).toEqual([[afterTimeoutSock], [afterPairingRestartSock]]);
    expect(waitForCredentialPersistence).toHaveBeenCalledOnce();
    expect(logoutWebMock).not.toHaveBeenCalled();
    expectLoginWaits(
      waitForConnection,
      harness.initialSock,
      afterTimeoutSock,
      afterPairingRestartSock,
    );
    expect(harness.initialSock.end).toHaveBeenCalledOnce();
    expect(afterTimeoutSock.end).toHaveBeenCalledOnce();
  });

  it.each([
    ["uncleared auth", 401, false, true, "failed", 1],
    ["absent auth", 401, false, false, "connected", 2],
    ["repeated logout", 401, true, true, "logged-out", 2],
    ["repeated timeout", 408, true, true, "failed", 2],
  ] as const)(
    "bounds login recovery for %s",
    async (_name, status, cleared, exists, outcome, waits) => {
      const harness = createLoginResultHarness();
      const error = { output: { statusCode: status } };
      if (status === 401) {
        logoutWebMock.mockResolvedValueOnce(cleared);
      }
      if (!cleared) {
        readWebAuthExistsForDecisionMock.mockResolvedValueOnce({ outcome: "stable", exists });
      }
      const waitForConnection = vi.fn().mockRejectedValueOnce(error);
      if (outcome === "connected") {
        waitForConnection.mockResolvedValueOnce(undefined);
      } else {
        waitForConnection.mockRejectedValueOnce(error);
      }
      createWaSocketMock.mockResolvedValue(harness.replacementSock as never);
      const result = await harness.run({ waitForConnection });

      expect(harness.initialSock.end).toHaveBeenCalledOnce();
      expect(createWaSocketMock).toHaveBeenCalledTimes(waits - 1);
      expect(waitForConnection).toHaveBeenCalledTimes(waits);
      expect(logoutWebMock).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
      if (outcome === "connected") {
        expect(result).toEqual({ outcome, restarted: true, sock: harness.replacementSock });
        expectLoginWaits(waitForConnection, harness.initialSock, harness.replacementSock);
      } else if (!cleared) {
        expect(result).toEqual({
          outcome,
          message:
            "existing auth could not be cleared. Remove or fix the configured WhatsApp auth directory, then retry login.",
          error,
        });
      } else {
        expect(result).toMatchObject({ outcome, statusCode: status, error });
      }
    },
  );

  it.each([{ outcome: "unstable" as const }, { outcome: "stable" as const, exists: false }])(
    "requires durable linked auth after socket open: %j",
    async (auth) => {
      readWebAuthExistsForDecisionMock.mockResolvedValue(auth);
      const waitForConnection = vi.fn().mockResolvedValueOnce(undefined);

      const result = await createLoginResultHarness().run({ waitForConnection });

      expect(result).toMatchObject({
        outcome: "failed",
        message: expect.stringMatching(/retry/i),
        error: { code: "whatsapp-auth-unstable" },
      });
    },
  );

  it("aborts an indefinite login wait when guarded credential persistence fails", async () => {
    const guardError = new Error("verified inference route changed");
    let persistenceFailure: { error: unknown } | null = null;
    const { promise: persistenceFailurePromise, resolve: resolvePersistenceFailure } =
      Promise.withResolvers<{ error: unknown }>();
    const pendingResult = createLoginResultHarness().run({
      waitForConnection: vi.fn(() => new Promise<void>(() => {})),
      credentialPersistenceFailure: persistenceFailurePromise,
      getCredentialPersistenceFailure: () => persistenceFailure,
    });

    persistenceFailure = { error: guardError };
    resolvePersistenceFailure(persistenceFailure);

    const result = await pendingResult;
    expect(result).toMatchObject({ outcome: "failed", error: guardError });
  });

  it("waits for queued creds persistence so linked auth survives an auth-dir reuse", async () => {
    const actualSession = await vi.importActual<typeof import("./session.js")>("./session.js");
    const actualAuthStore =
      await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-auth-durability-"));
    try {
      readWebAuthExistsForDecisionMock.mockImplementation(
        actualSession.readWebAuthExistsForDecision,
      );
      let credsSaved = false;
      enqueueCredsSave(
        authDir,
        async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });
          await writeCredsJsonAtomically(authDir, { me: { id: "123@s.whatsapp.net" } });
          credsSaved = true;
        },
        () => {},
      );

      const harness = createLoginResultHarness();
      const result = await harness.run({
        authDir,
        waitForConnection: vi.fn().mockResolvedValueOnce(undefined),
      });

      expect(credsSaved).toBe(true);
      expect(result).toEqual({ outcome: "connected", restarted: false, sock: harness.initialSock });
      expect(readWebAuthExistsForDecisionMock).toHaveBeenCalledWith(authDir);
      // A fresh read of the same auth dir is what a restarted/rebuilt container does.
      await expect(actualAuthStore.webAuthExists(authDir)).resolves.toBe(true);
    } finally {
      await fs.rm(authDir, { recursive: true, force: true });
    }
  });

  it("keeps the ready controller published while a different-auth replacement connects", async () => {
    const disposeRuntimeContext = vi.fn();
    registerChannelRuntimeContextMock.mockReturnValueOnce({ dispose: disposeRuntimeContext });
    const liveController = createController();
    const liveListener = createListenerStub("live");
    queueConnectedSocket();
    await liveController.openConnection({
      connectionId: "live-conn",
      createListener: async () => liveListener,
    });

    const replacement = createController({ authDir: "/tmp/wa-auth-2" });

    try {
      createWaSocketMock.mockResolvedValueOnce(createSocketWithTransportEmitter() as never);
      waitForWaConnectionMock.mockRejectedValueOnce(new Error("replacement failed"));

      await expect(
        replacement.openConnection({
          connectionId: "replacement-conn",
          createListener: async () => liveListener,
        }),
      ).rejects.toThrow("replacement failed");

      expect(registerChannelRuntimeContextMock).toHaveBeenCalledTimes(3);
      expect(registerChannelRuntimeContextMock).toHaveBeenLastCalledWith({
        channelRuntime: runtimeContextMocks.channelRuntime,
        channelId: "whatsapp",
        accountId: "work",
        capability: "connection-owner-pending",
        context: true,
        abortSignal: undefined,
      });
      const activeControllerRegistrations = registerChannelRuntimeContextMock.mock.calls.filter(
        ([registration]) => registration.capability === "connection-controller",
      );
      expect(activeControllerRegistrations).toHaveLength(1);
      expect(activeControllerRegistrations[0]?.[0].context).toBe(liveController);
    } finally {
      await replacement.shutdown();
      await liveController.shutdown();
    }
    expect(disposeRuntimeContext).toHaveBeenCalledOnce();
  });

  it("releases connection ownership only after the Baileys socket closes", async () => {
    const order: string[] = [];
    const sock = createSocketWithTransportEmitter(() => {
      order.push("socket-close");
    });
    connectionOwnerMocks.release.mockImplementationOnce(async () => {
      order.push("owner-release");
    });
    queueConnectedSocket(sock);

    await open("owned-conn");
    await controller.shutdown();

    expect(order).toEqual(["socket-close", "owner-release"]);
  });

  it("joins pending ownership acquisition before shutdown returns", async () => {
    const { promise: ownerPromise, resolve: resolveOwner } = Promise.withResolvers<{
      release: () => Promise<void>;
    }>();
    connectionOwnerMocks.acquire.mockReturnValueOnce(ownerPromise);
    const openPromise = open("pending-owner");
    const shutdownPromise = controller.shutdown();

    resolveOwner({ release: connectionOwnerMocks.release });

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
    const openPromise = open("pending-handshake");
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
    const { promise: listenerPromise, resolve: resolveListener } =
      Promise.withResolvers<ReturnType<typeof createListenerStub>>();
    queueConnectedSocket(sock);
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
    queueConnectedSocket(sock);
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

  it.each([
    ["transport", "socket close could not be confirmed", 0],
    ["credentials", "credential persistence did not drain", 0],
    ["release", "owner release failed", 1],
  ] as const)(
    "retains ownership after %s failure until cleanup can retry",
    async (stage, message, releases) => {
      const sock = createSocketWithTransportEmitter();
      if (stage === "transport") {
        sock.end.mockRejectedValueOnce(new Error("end failed"));
        sock.ws.close.mockRejectedValueOnce(new Error("websocket close failed"));
      } else if (stage === "credentials") {
        waitForCredsSaveQueueWithTimeoutMock
          .mockResolvedValueOnce("timed_out")
          .mockResolvedValueOnce("drained");
      } else {
        connectionOwnerMocks.release
          .mockRejectedValueOnce(new Error("owner release failed"))
          .mockResolvedValueOnce(undefined);
      }
      queueConnectedSocket(sock);
      await open(`cleanup-${stage}`);
      await expect(controller.shutdown()).rejects.toThrow(message);
      expect(connectionOwnerMocks.release).toHaveBeenCalledTimes(releases);
      if (stage !== "transport") {
        expect(controller.getActiveListener()).toBeNull();
        expect(controller.getCurrentSock()).toBeNull();
      }
      if (stage === "credentials") {
        expect(sock.end).toHaveBeenCalledOnce();
      }
      await expect(controller.shutdown()).resolves.toBeUndefined();
      expect(connectionOwnerMocks.release).toHaveBeenCalledTimes(releases + 1);
    },
  );

  it("tracks real websocket frame activity in the connection snapshot", async () => {
    vi.useFakeTimers();
    const controllerValue = createController({ keepAlive: true, heartbeatSeconds: 1 });

    try {
      const sock = createSocketWithTransportEmitter();
      queueConnectedSocket(sock);

      const snapshots: Array<{ lastTransportActivityAt: number }> = [];
      await controllerValue.openConnection({
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
      await controllerValue.shutdown();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "transport stall before app silence",
      transportTimeoutMs: 30,
      messageTimeoutMs: 3_000,
      watchdogCheckMs: 5,
      beforeMs: 0,
      connectionId: "conn-transport-timeout",
    },
    {
      name: "messageTimeoutMs * 4 on a fresh connection",
      transportTimeoutMs: 10_000,
      messageTimeoutMs: 100,
      watchdogCheckMs: 10,
      beforeMs: 380,
      connectionId: "conn-app-silence",
    },
  ])("forces reconnect for $name", async ({ name: _name, beforeMs, connectionId, ...timing }) => {
    vi.useFakeTimers();
    const controllerLocal = createController({ keepAlive: true, heartbeatSeconds: 1, ...timing });
    try {
      queueConnectedSocket();
      const timeouts: string[] = [];
      await controllerLocal.openConnection({
        connectionId,
        createListener: async () => createListenerStub() as never,
        onWatchdogTimeout: () => timeouts.push("timeout"),
      });
      if (beforeMs) {
        // Keep transport healthy while checking the app-silence boundary.
        await vi.advanceTimersByTimeAsync(beforeMs);
        expect(timeouts).toHaveLength(0);
      }
      await vi.advanceTimersByTimeAsync(40);
      expect(timeouts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await controllerLocal.shutdown();
      vi.useRealTimers();
    }
  });

  it("settles close and cancels setup when the stop signal is already aborted", async () => {
    const abort = new AbortController();
    const stopReason = new Error("already stopped");
    abort.abort(stopReason);
    const preAbortedController = createController({ abortSignal: abort.signal });

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
      await expect(open("conn-pre-aborted", preAbortedController)).rejects.toThrow(
        "controller is shutting down",
      );

      expect(ownerAcquireSignal?.aborted).toBe(true);
      expect(ownerAcquireSignal?.reason).toBe(stopReason);
      expect(createWaSocketMock).not.toHaveBeenCalled();
    } finally {
      await preAbortedController.shutdown();
    }
  });
});
