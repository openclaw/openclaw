import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import type { runIMessageCatchup } from "./monitor/catchup-bridge.js";
import type { advanceIMessageCatchupCursor } from "./monitor/catchup.js";
import type { IMessagePayload } from "./monitor/types.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const runIMessageCatchupMock = vi.hoisted(() => vi.fn<typeof runIMessageCatchup>());
const advanceIMessageCatchupCursorMock = vi.hoisted(() =>
  vi.fn<typeof advanceIMessageCatchupCursor>(async () => true),
);
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const recordInboundSessionMock = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
const dispatchInboundMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }) as const),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    recordInboundSession: recordInboundSessionMock,
    upsertChannelPairingRequest: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

vi.mock("./monitor/catchup-bridge.js", () => ({
  runIMessageCatchup: runIMessageCatchupMock,
}));

vi.mock("./monitor/catchup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor/catchup.js")>();
  return {
    ...actual,
    advanceIMessageCatchupCursor: advanceIMessageCatchupCursorMock,
  };
});

type TestIMessagePayload = IMessagePayload & {
  coalescedMessageGuids?: string[];
  coalescedMessageIds?: number[];
};

function createMessage(overrides: Partial<TestIMessagePayload> = {}): TestIMessagePayload {
  return {
    id: 50,
    guid: "guid-50",
    chat_id: 7,
    sender: "+15550001111",
    is_from_me: false,
    text: "hello",
    is_group: false,
    created_at: "2026-05-22T09:00:00.000Z",
    ...overrides,
  };
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createConfig(options: { debounceMs?: number } = {}) {
  return {
    channels: {
      imessage: {
        catchup: { enabled: true },
        dmPolicy: "allowlist",
        allowFrom: ["+15550001111"],
      },
    },
    messages: { inbound: { debounceMs: options.debounceMs ?? 0 } },
  };
}

describe("iMessage catchup live cursor coordination", () => {
  beforeEach(() => {
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    runIMessageCatchupMock.mockReset();
    advanceIMessageCatchupCursorMock.mockReset().mockResolvedValue(true);
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue([]);
    recordInboundSessionMock.mockClear();
    dispatchInboundMessageMock.mockClear();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/transport-ready-runtime");
    vi.doUnmock("openclaw/plugin-sdk/conversation-runtime");
    vi.doUnmock("openclaw/plugin-sdk/reply-runtime");
    vi.doUnmock("./client.js");
    vi.doUnmock("./monitor/abort-handler.js");
    vi.doUnmock("./monitor/catchup-bridge.js");
    vi.doUnmock("./monitor/catchup.js");
    vi.resetModules();
  });

  it("does not run live cursor advancement for catchup replay rows", async () => {
    runIMessageCatchupMock.mockImplementation(async (params) => {
      await params.dispatchPayload(createMessage());
      return {
        querySucceeded: true,
        fetchedCount: 1,
        replayed: 1,
        skippedFromMe: 0,
        skippedPreCursor: 0,
        skippedGivenUp: 0,
        failed: 0,
        givenUp: 0,
        cursorBefore: null,
        cursorAfter: { lastSeenMs: 1, lastSeenRowid: 50 },
        windowStartMs: 0,
        windowEndMs: 1,
      };
    });
    createIMessageRpcClientMock.mockResolvedValue({
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    } as never);

    await monitorIMessageProvider({
      config: createConfig() as never,
      runtime: createRuntime(),
    });

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(advanceIMessageCatchupCursorMock).not.toHaveBeenCalled();
  });

  it("waits for startup catchup to finish before live messages advance the cursor", async () => {
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    runIMessageCatchupMock.mockImplementation(async () => {
      onNotification?.({
        method: "message",
        params: { message: createMessage({ id: 75, guid: "guid-75" }) },
      });
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      });
      expect(advanceIMessageCatchupCursorMock).not.toHaveBeenCalled();
      return {
        querySucceeded: true,
        fetchedCount: 0,
        replayed: 0,
        skippedFromMe: 0,
        skippedPreCursor: 0,
        skippedGivenUp: 0,
        failed: 0,
        givenUp: 0,
        cursorBefore: null,
        cursorAfter: { lastSeenMs: 1, lastSeenRowid: 50 },
        windowStartMs: 0,
        windowEndMs: 1,
      };
    });
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      onNotification = params?.onNotification;
      return {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      } as never;
    });

    await monitorIMessageProvider({
      config: createConfig() as never,
      runtime: createRuntime(),
    });

    expect(advanceIMessageCatchupCursorMock).toHaveBeenCalledWith(
      "default",
      { lastSeenMs: Date.parse("2026-05-22T09:00:00.000Z"), lastSeenRowid: 75 },
      { maxFailureRetries: 10 },
    );
  });

  it("skips catchup replay rows already resolved by startup live coalescing", async () => {
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    let releaseLiveDispatch!: () => void;
    const liveDispatchStarted = new Promise<void>((resolve) => {
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseLiveDispatch = release;
        });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
    });
    runIMessageCatchupMock.mockImplementation(async (params) => {
      onNotification?.({
        method: "message",
        params: {
          message: createMessage({
            id: 100,
            guid: "guid-100",
            coalescedMessageGuids: ["guid-100", "guid-101"],
            coalescedMessageIds: [100, 101],
          }),
        },
      });
      await liveDispatchStarted;

      const replay = params.dispatchPayload(createMessage({ id: 101, guid: "guid-101" }));
      await Promise.resolve();
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(advanceIMessageCatchupCursorMock).not.toHaveBeenCalled();
      releaseLiveDispatch();
      await replay;
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      return {
        querySucceeded: true,
        fetchedCount: 1,
        replayed: 1,
        skippedFromMe: 0,
        skippedPreCursor: 0,
        skippedGivenUp: 0,
        failed: 0,
        givenUp: 0,
        cursorBefore: null,
        cursorAfter: { lastSeenMs: 1, lastSeenRowid: 101 },
        windowStartMs: 0,
        windowEndMs: 1,
      };
    });
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      onNotification = params?.onNotification;
      return {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      } as never;
    });

    await monitorIMessageProvider({
      config: createConfig() as never,
      runtime: createRuntime(),
    });

    await vi.waitFor(() => {
      expect(advanceIMessageCatchupCursorMock).toHaveBeenCalledWith(
        "default",
        { lastSeenMs: Date.parse("2026-05-22T09:00:00.000Z"), lastSeenRowid: 101 },
        { maxFailureRetries: 10 },
      );
    });
  });

  it("replays startup catchup rows when the overlapping live dispatch fails", async () => {
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    let rejectLiveDispatch!: (err: Error) => void;
    const liveDispatchStarted = new Promise<void>((resolve) => {
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((_resolve, reject) => {
          rejectLiveDispatch = reject;
        });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
    });
    runIMessageCatchupMock.mockImplementation(async (params) => {
      const message = createMessage({ id: 125, guid: "guid-125" });
      onNotification?.({
        method: "message",
        params: { message },
      });
      await liveDispatchStarted;

      const replay = params.dispatchPayload(message);
      await Promise.resolve();
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      rejectLiveDispatch(new Error("live dispatch failed"));
      await replay;
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(advanceIMessageCatchupCursorMock).not.toHaveBeenCalled();
      return {
        querySucceeded: true,
        fetchedCount: 1,
        replayed: 1,
        skippedFromMe: 0,
        skippedPreCursor: 0,
        skippedGivenUp: 0,
        failed: 0,
        givenUp: 0,
        cursorBefore: null,
        cursorAfter: { lastSeenMs: 1, lastSeenRowid: 125 },
        windowStartMs: 0,
        windowEndMs: 1,
      };
    });
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      onNotification = params?.onNotification;
      return {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      } as never;
    });

    await monitorIMessageProvider({
      config: createConfig() as never,
      runtime: createRuntime(),
    });

    expect(advanceIMessageCatchupCursorMock).not.toHaveBeenCalled();
  });

  it("tracks startup live rows before debounce flush so catchup waits for the live attempt", async () => {
    vi.useFakeTimers();
    try {
      let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
      runIMessageCatchupMock.mockImplementation(async (params) => {
        const message = createMessage({ id: 135, guid: "guid-135" });
        onNotification?.({
          method: "message",
          params: { message },
        });

        const replay = params.dispatchPayload(message);
        await Promise.resolve();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        await replay;
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
        return {
          querySucceeded: true,
          fetchedCount: 1,
          replayed: 1,
          skippedFromMe: 0,
          skippedPreCursor: 0,
          skippedGivenUp: 0,
          failed: 0,
          givenUp: 0,
          cursorBefore: null,
          cursorAfter: { lastSeenMs: 1, lastSeenRowid: 135 },
          windowStartMs: 0,
          windowEndMs: 1,
        };
      });
      createIMessageRpcClientMock.mockImplementation(async (params) => {
        onNotification = params?.onNotification;
        return {
          request: vi.fn(async () => ({ subscription: 1 })),
          waitForClose: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        } as never;
      });

      await monitorIMessageProvider({
        config: createConfig({ debounceMs: 1000 }) as never,
        runtime: createRuntime(),
      });

      await vi.waitFor(() => {
        expect(advanceIMessageCatchupCursorMock).toHaveBeenCalledWith(
          "default",
          { lastSeenMs: Date.parse("2026-05-22T09:00:00.000Z"), lastSeenRowid: 135 },
          { maxFailureRetries: 10 },
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not advance startup live cursor past catchup rows left for a later pass", async () => {
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    runIMessageCatchupMock.mockImplementation(async () => {
      onNotification?.({
        method: "message",
        params: { message: createMessage({ id: 300, guid: "guid-300" }) },
      });
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      });
      return {
        querySucceeded: true,
        fetchedCount: 50,
        hasMoreRows: true,
        replayed: 50,
        skippedFromMe: 0,
        skippedPreCursor: 0,
        skippedGivenUp: 0,
        failed: 0,
        givenUp: 0,
        cursorBefore: null,
        cursorAfter: { lastSeenMs: Date.parse("2026-05-22T08:59:00.000Z"), lastSeenRowid: 100 },
        windowStartMs: 0,
        windowEndMs: 1,
      };
    });
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      onNotification = params?.onNotification;
      return {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      } as never;
    });

    await monitorIMessageProvider({
      config: createConfig() as never,
      runtime: createRuntime(),
    });

    expect(advanceIMessageCatchupCursorMock).not.toHaveBeenCalled();
  });

  it("does not advance post-fence live cursor past catchup rows left for a later pass", async () => {
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    runIMessageCatchupMock.mockResolvedValue({
      querySucceeded: true,
      fetchedCount: 50,
      hasMoreRows: true,
      replayed: 50,
      skippedFromMe: 0,
      skippedPreCursor: 0,
      skippedGivenUp: 0,
      failed: 0,
      givenUp: 0,
      cursorBefore: null,
      cursorAfter: { lastSeenMs: Date.parse("2026-05-22T08:59:00.000Z"), lastSeenRowid: 100 },
      windowStartMs: 0,
      windowEndMs: 1,
    });
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      onNotification = params?.onNotification;
      return {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {
          onNotification?.({
            method: "message",
            params: { message: createMessage({ id: 300, guid: "guid-300" }) },
          });
          await vi.waitFor(() => {
            expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
          });
        }),
        stop: vi.fn(async () => {}),
      } as never;
    });

    await monitorIMessageProvider({
      config: createConfig() as never,
      runtime: createRuntime(),
    });

    expect(advanceIMessageCatchupCursorMock).not.toHaveBeenCalled();
  });

  it("does not advance post-fence live cursor when startup catchup query fails", async () => {
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    runIMessageCatchupMock.mockResolvedValue({
      querySucceeded: false,
      fetchedCount: 0,
      replayed: 0,
      skippedFromMe: 0,
      skippedPreCursor: 0,
      skippedGivenUp: 0,
      failed: 0,
      givenUp: 0,
      cursorBefore: null,
      cursorAfter: { lastSeenMs: 0, lastSeenRowid: 0 },
      windowStartMs: 0,
      windowEndMs: 1,
    });
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      onNotification = params?.onNotification;
      return {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {
          onNotification?.({
            method: "message",
            params: { message: createMessage({ id: 300, guid: "guid-300" }) },
          });
          await vi.waitFor(() => {
            expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
          });
        }),
        stop: vi.fn(async () => {}),
      } as never;
    });

    await monitorIMessageProvider({
      config: createConfig() as never,
      runtime: createRuntime(),
    });

    expect(advanceIMessageCatchupCursorMock).not.toHaveBeenCalled();
  });
});
