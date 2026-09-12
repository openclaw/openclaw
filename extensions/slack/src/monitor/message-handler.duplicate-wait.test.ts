import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";

type InboundDebounceFlush = { admission: Promise<void>; completion: Promise<void> };
const enqueueMock = vi.fn(async (_entry: unknown) => {});
const onFlushCallbacks: Array<
  (
    entries: Array<Record<string, unknown>>,
    createFlush: typeof createTestInboundDebounceFlush,
  ) => InboundDebounceFlush
> = [];
const prepareSlackMessageMock = vi.fn(async () => ({ ctxPayload: {} }));
const dispatchPreparedSlackMessageMock = vi.fn(async () => {});
const { createSlackMessageHandler } = await import("./message-handler.js");

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    createChannelInboundDebouncer: (
      params: Parameters<typeof actual.createChannelInboundDebouncer<Record<string, unknown>>>[0],
    ) => {
      onFlushCallbacks.push(params.onFlush);
      return {
        debounceMs: 10,
        debouncer: {
          enqueue: (entry: unknown) => enqueueMock(entry),
          flushKey: async () => {},
          cancelKey: () => false,
          drain: async () => {},
        },
      };
    },
    shouldDebounceTextInbound: () => true,
  };
});

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: async ({ message }: { message: Record<string, unknown> }) => message,
  }),
}));
vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepareSlackMessageMock,
  dispatchPreparedSlackMessage: dispatchPreparedSlackMessageMock,
}));

function runOnFlush(entries: Array<Record<string, unknown>>): Promise<void> {
  return onFlushCallbacks[0]!(entries, createTestInboundDebounceFlush).completion;
}

function createContext() {
  return {
    cfg: {},
    accountId: "default",
    app: { client: {} },
    runtime: {},
    rememberSlackChannelType: () => {},
  } as unknown as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
}

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  vi.clearAllMocks();
  onFlushCallbacks.length = 0;
});

describe("Slack duplicate wait admission", () => {
  it("defers ingress before waiting for a duplicate's dispatch claim", async () => {
    const duplicate = createDeferred<boolean>();
    const onDispatchWaiting = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
      dispatchReplayGuard: {
        claim: async () => ({ kind: "inflight", pending: duplicate.promise }),
      } as unknown as NonNullable<
        Parameters<typeof createSlackMessageHandler>[0]["dispatchReplayGuard"]
      >,
    });
    const handled = handler(
      { type: "message", channel: "C_TEST", ts: "1709000000.009999", text: "hello" } as never,
      {
        source: "message",
        awaitDispatch: true,
        turnAdoptionLifecycle: {
          admission: "exclusive",
          abortSignal: new AbortController().signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAbandoned: vi.fn(),
          onDispatchWaiting,
        },
      },
    );
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledOnce());
    const { createChannelInboundDebouncer } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/channel-inbound")
    >("openclaw/plugin-sdk/channel-inbound");
    const { debouncer } = createChannelInboundDebouncer<Record<string, unknown>>({
      cfg: {},
      channel: "slack",
      debounceMsOverride: 0,
      buildKey: () => "thread",
      serializeImmediate: true,
      onFlush: (entries, createFlush) => onFlushCallbacks[0]!(entries, createFlush),
    });
    let admitted = false;
    const admission = debouncer.enqueue(enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>);
    void admission.then(() => {
      admitted = true;
    });
    try {
      await vi.waitFor(() => expect(onDispatchWaiting).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(admitted).toBe(true));
      expect(prepareSlackMessageMock).not.toHaveBeenCalled();
    } finally {
      duplicate.resolve(true);
      await admission;
      await debouncer.drain();
      await handled;
    }
    expect(dispatchPreparedSlackMessageMock).not.toHaveBeenCalled();
  });

  it("requeues a released twin and releases other claims from its flush", async () => {
    const owner = createDeferred<boolean>();
    const release = vi.fn();
    const claim = vi
      .fn()
      .mockResolvedValue({ kind: "claimed", handle: { commit: vi.fn(), release: vi.fn() } })
      .mockResolvedValueOnce({ kind: "claimed", handle: { commit: vi.fn(), release } })
      .mockResolvedValueOnce({ kind: "inflight", pending: owner.promise });
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
      dispatchReplayGuard: { claim } as unknown as NonNullable<
        Parameters<typeof createSlackMessageHandler>[0]["dispatchReplayGuard"]
      >,
    });
    for (const ts of ["1709000000.000701", "1709000000.000702"]) {
      await handler(
        { type: "message", channel: "C111", user: "U111", ts, text: "retry me" } as never,
        { source: "message" },
      );
    }
    const entries = enqueueMock.mock.calls.map((call) => call[0]) as Array<Record<string, unknown>>;
    const flushing = runOnFlush(entries);
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    vi.useFakeTimers();
    try {
      owner.reject(new Error("original dispatch failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toHaveBeenCalledOnce();
      expect(claim).toHaveBeenCalledTimes(2);
      expect(prepareSlackMessageMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushing;
      expect(enqueueMock).toHaveBeenCalledTimes(4);
      expect(enqueueMock.mock.calls[2]?.[0]).toMatchObject({ retry: { attempt: 1 } });
      expect(enqueueMock.mock.calls[3]?.[0]).toMatchObject({ retry: { attempt: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });
});
