// Slack tests cover message handler observability, replay, and retry behavior.
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type InboundDebounceFlush = { admission: Promise<void>; completion: Promise<void> };

let useRealDebouncer = false;
const realDebouncers: Array<{ drain: () => Promise<void> }> = [];
const enqueueMock = vi.fn(async (_entry: unknown) => {});
const flushKeyMock = vi.fn(async (_key: string) => {});
const onFlushCallbacks: Array<
  (
    entries: Array<Record<string, unknown>>,
    createFlush: typeof createTestInboundDebounceFlush,
  ) => InboundDebounceFlush
> = [];
const prepareSlackMessageMock = vi.fn(
  async (_params?: {
    ctx: Parameters<typeof createSlackMessageHandler>[0]["ctx"];
    opts: {
      onVisibleDrop?: () => void;
      ingressObserver?: ReturnType<typeof createIngressObserver>;
    };
  }): Promise<{
    ctxPayload: Record<string, unknown>;
    route?: { sessionKey: string };
  } | null> => ({ ctxPayload: {} }),
);
const dispatchPreparedSlackMessageMock = vi.fn(async (_prepared: unknown) => {});
const resolveThreadTsMock = vi.fn(async ({ message }: { message: Record<string, unknown> }) => ({
  ...message,
}));
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
      if (useRealDebouncer) {
        const result = actual.createChannelInboundDebouncer(params);
        realDebouncers.push(result.debouncer);
        return result;
      }
      return {
        debounceMs: 10,
        debouncer: {
          enqueue: (entry: unknown) => enqueueMock(entry),
          flushKey: (key: string) => flushKeyMock(key),
          cancelKey: () => false,
          drain: async () => {},
        },
      };
    },
    shouldDebounceTextInbound: ({ hasMedia }: { hasMedia?: boolean }) => !hasMedia,
  };
});

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: (entry: { message: Record<string, unknown> }) => resolveThreadTsMock(entry),
  }),
}));

function runOnFlush(entries: Array<Record<string, unknown>>): Promise<void> {
  const flush = onFlushCallbacks[0]?.(entries, createTestInboundDebounceFlush);
  if (!flush) {
    throw new Error("Slack inbound debounce callback missing");
  }
  return flush.completion;
}

vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepareSlackMessageMock,
  dispatchPreparedSlackMessage: dispatchPreparedSlackMessageMock,
}));

function createIngressObserver() {
  const finish = vi.fn((_outcome?: unknown) => {});
  return {
    stage: vi.fn(),
    progress: vi.fn(),
    correlate: vi.fn(),
    begin: vi.fn((_operation?: unknown) => ({ finish })),
    finish,
  };
}

function createAccount(): Parameters<typeof createSlackMessageHandler>[0]["account"] {
  return {
    accountId: "default",
    enabled: true,
    identity: "bot",
    botTokenSource: "none",
    appTokenSource: "none",
    userTokenSource: "none",
    config: {},
  };
}

function createContext(overrides?: {
  cfg?: OpenClawConfig;
  rememberSlackChannelType?: (
    channel: string | null | undefined,
    channelType: string | null | undefined,
  ) => void;
}) {
  return {
    cfg: overrides?.cfg ?? {},
    accountId: "default",
    teamId: "T111",
    app: {
      client: {},
    },
    runtime: {},
    rememberSlackChannelType: (
      channel: string | null | undefined,
      channelType: string | null | undefined,
    ) => overrides?.rememberSlackChannelType?.(channel, channelType),
  } as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
}

function createHandlerWithTracker(overrides?: {
  cfg?: OpenClawConfig;
  abortSignal?: AbortSignal;
  rememberSlackChannelType?: (
    channel: string | null | undefined,
    channelType: string | null | undefined,
  ) => void;
}) {
  const trackEvent = vi.fn();
  const ctx = createContext(overrides);
  const handler = createSlackMessageHandler({
    ctx,
    abortSignal: overrides?.abortSignal,
    account: createAccount(),
    trackEvent,
  });
  return { handler, trackEvent, ctx };
}

type SlackHandler = ReturnType<typeof createHandlerWithTracker>["handler"];
type SlackHandlerMessage = Parameters<SlackHandler>[0];

function createMessage(overrides: Partial<SlackHandlerMessage> = {}): SlackHandlerMessage {
  return {
    type: "message",
    channel: "C111",
    user: "U111",
    ts: "1709000000.000000",
    text: "hello",
    ...overrides,
  };
}

describe("createSlackMessageHandler observability and replay", () => {
  beforeEach(() => {
    useRealDebouncer = false;
    realDebouncers.length = 0;
    clearRuntimeConfigSnapshot();
    enqueueMock.mockClear();
    flushKeyMock.mockClear();
    onFlushCallbacks.length = 0;
    prepareSlackMessageMock.mockClear();
    dispatchPreparedSlackMessageMock.mockClear();
    resolveThreadTsMock.mockClear();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("does not advance progress when a durable retry enters the handler before routing resolves", async () => {
    const routingStarted = createDeferred<void>();
    resolveThreadTsMock.mockImplementationOnce(
      async ({ message }: { message: Record<string, unknown> }) => {
        await routingStarted.promise;
        return { ...message };
      },
    );
    const ingressObserver = createIngressObserver();
    const { handler } = createHandlerWithTracker();
    const message: Parameters<typeof handler>[0] = {
      type: "message",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000559",
      text: "retry body",
    };
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      observer: ingressObserver,
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    } satisfies NonNullable<Parameters<typeof handler>[1]["turnAdoptionLifecycle"]>;

    const handled = handler(message, { source: "message", turnAdoptionLifecycle });

    await vi.waitFor(() => expect(ingressObserver.stage).toHaveBeenCalledWith("queued", "none"));
    expect(ingressObserver.progress).not.toHaveBeenCalled();

    routingStarted.resolve();
    await handled;
  });

  it("carries durable ingress ownership into prepared dispatch", async () => {
    prepareSlackMessageMock.mockResolvedValueOnce({
      ctxPayload: {},
      route: { sessionKey: "agent:main:slack:channel:C111" },
    });
    const { handler } = createHandlerWithTracker();
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
      onSessionRouted: vi.fn(async () => {}),
    } satisfies NonNullable<Parameters<typeof handler>[1]["turnAdoptionLifecycle"]>;
    const message: Parameters<typeof handler>[0] = {
      type: "message",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000550",
      text: "durable message",
    };
    const handled = handler(message, {
      source: "message",
      awaitDispatch: true,
      turnAdoptionLifecycle,
    });

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    expect(resolveThreadTsMock).toHaveBeenCalledWith({
      message: expect.objectContaining({ channel: "C111", ts: "1709000000.000550" }),
      source: "message",
      turnAdoptionLifecycle,
    });
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await runOnFlush([entry]);
    await handled;

    // The flush wraps the lifecycle to settle dispatch-dedupe claims, so assert
    // ownership forwarding rather than function identity.
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(turnAdoptionLifecycle.onSessionRouted).toHaveBeenCalledExactlyOnceWith(
      "agent:main:slack:channel:C111",
    );
    expect(turnAdoptionLifecycle.onSessionRouted.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchPreparedSlackMessageMock.mock.invocationCallOrder[0] ?? 0,
    );
    const prepared = dispatchPreparedSlackMessageMock.mock.calls[0]?.[0] as {
      turnAdoptionLifecycle?: typeof turnAdoptionLifecycle;
    };
    expect(prepared.turnAdoptionLifecycle?.admission).toBe("exclusive");
    expect(prepared.turnAdoptionLifecycle?.abortSignal).toBe(turnAdoptionLifecycle.abortSignal);
    await prepared.turnAdoptionLifecycle?.onAdopted();
    expect(turnAdoptionLifecycle.onAdopted).toHaveBeenCalledTimes(1);
    prepared.turnAdoptionLifecycle?.onDeferred();
    expect(turnAdoptionLifecycle.onDeferred).toHaveBeenCalledTimes(1);
  });

  it("scopes the durable ingress observer to Slack IDs before preparation", async () => {
    prepareSlackMessageMock.mockResolvedValueOnce({
      ctxPayload: {},
      route: { sessionKey: "agent:main:slack:channel:C111" },
    });
    const ingressObserver = createIngressObserver();
    const { handler } = createHandlerWithTracker();
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      observer: ingressObserver,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
      onSessionRouted: vi.fn(async () => {}),
    } satisfies NonNullable<Parameters<typeof handler>[1]["turnAdoptionLifecycle"]>;
    const message: Parameters<typeof handler>[0] = {
      type: "message",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000560",
      text: "secret body stays out of observation",
    };
    const handled = handler(message, {
      source: "message",
      awaitDispatch: true,
      turnAdoptionLifecycle,
    });

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    expect(resolveThreadTsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({ ingressObserver: expect.any(Object) }),
      }),
    );
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await runOnFlush([entry]);
    await handled;

    expect(prepareSlackMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({ ingressObserver: expect.any(Object) }),
      }),
    );
    expect(ingressObserver.correlate).toHaveBeenCalledWith({
      providerEventType: "message",
      teamId: "T111",
      channelId: "C111",
      messageTs: "1709000000.000560",
      threadTs: "1709000000.000560",
    });
    expect(ingressObserver.stage).toHaveBeenCalledWith("queued", "none");
    expect(ingressObserver.progress).not.toHaveBeenCalledWith("queued", "none");
    expect(ingressObserver.stage).toHaveBeenCalledWith("dedupe_wait", "none");
    expect(JSON.stringify(ingressObserver.correlate.mock.calls)).not.toContain("secret body");
  });

  it("refreshes later observer correlation after resolving a missing reply thread timestamp", async () => {
    prepareSlackMessageMock.mockResolvedValueOnce({
      ctxPayload: {},
      route: { sessionKey: "agent:main:slack:channel:C111" },
    });
    resolveThreadTsMock.mockImplementationOnce(
      async ({ message }: { message: Record<string, unknown> }) => ({
        ...message,
        thread_ts: "1709000000.000500",
      }),
    );
    const ingressObserver = createIngressObserver();
    const { handler } = createHandlerWithTracker();
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      observer: ingressObserver,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
      onSessionRouted: vi.fn(async () => {}),
    } satisfies NonNullable<Parameters<typeof handler>[1]["turnAdoptionLifecycle"]>;
    const handled = handler(
      createMessage({
        parent_user_id: "U_PARENT",
        ts: "1709000000.000561",
        text: "reply body stays out of observation",
      }),
      { source: "message", awaitDispatch: true, turnAdoptionLifecycle },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await runOnFlush([entry]);
    await handled;

    const preparedObserver = prepareSlackMessageMock.mock.calls[0]?.[0]?.opts.ingressObserver;
    expect(preparedObserver).toBeDefined();
    preparedObserver?.progress("thread_history", "slack_api");

    expect(ingressObserver.correlate).toHaveBeenLastCalledWith({
      providerEventType: "message",
      teamId: "T111",
      channelId: "C111",
      messageTs: "1709000000.000561",
      threadTs: "1709000000.000500",
    });
    expect(JSON.stringify(ingressObserver.correlate.mock.calls)).not.toContain("reply body");
  });

  it("keeps every same-flush duplicate event observer through preparation", async () => {
    const firstObserver = createIngressObserver();
    const secondObserver = createIngressObserver();
    const { handler } = createHandlerWithTracker();
    const message = createMessage({ ts: "1709000000.000570", text: "<@UBOT> hello" });
    const first = handler(message, {
      source: "message",
      awaitDispatch: true,
      ingressObserver: firstObserver,
    });
    const second = handler(message, {
      source: "app_mention",
      wasMentioned: true,
      awaitDispatch: true,
      ingressObserver: secondObserver,
    });
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(2));

    const entries = enqueueMock.mock.calls.map((call) => call[0]) as Array<Record<string, unknown>>;
    await runOnFlush(entries);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    const preparedObserver = prepareSlackMessageMock.mock.calls[0]?.[0]?.opts.ingressObserver;
    expect(preparedObserver).toBeDefined();
    preparedObserver?.progress("thread_history", "slack_api");
    const ticket = preparedObserver?.begin({
      kind: "api",
      method: "conversations.replies",
      profile: "pooled_listener",
    });
    ticket?.finish("completed");

    expect(firstObserver.progress).toHaveBeenCalledWith("thread_history", "slack_api");
    expect(secondObserver.progress).toHaveBeenCalledWith("thread_history", "slack_api");
    expect(firstObserver.begin).toHaveBeenCalledWith({
      kind: "api",
      method: "conversations.replies",
      profile: "pooled_listener",
    });
    expect(secondObserver.begin).toHaveBeenCalledWith({
      kind: "api",
      method: "conversations.replies",
      profile: "pooled_listener",
    });
  });

  it("dispatches a message/app_mention twin pair exactly once", async () => {
    // Slack emits both events with distinct event_ids for one mention post, so
    // the durable ingress queue admits both; the logical (channel, ts) dispatch
    // guard must collapse them to a single dispatch.
    const { handler } = createHandlerWithTracker();
    const twinTs = "1709000000.000777";
    const asMessage = handler(createMessage({ ts: twinTs, text: "<@UBOT> hello" }), {
      source: "message",
      awaitDispatch: true,
    });
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const first = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await runOnFlush([first]);
    await asMessage;
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);

    const asMention = handler(createMessage({ ts: twinTs, text: "<@UBOT> hello" }), {
      source: "app_mention",
      wasMentioned: true,
      awaitDispatch: true,
    });
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(2));
    const second = enqueueMock.mock.calls[1]?.[0] as Record<string, unknown>;
    await runOnFlush([second]);
    await asMention;
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["message", "app_mention"],
    ["app_mention", "message"],
  ] as const)(
    "deduplicates message/app_mention twins in one flush (%s before %s)",
    async (firstSource, secondSource) => {
      const { handler } = createHandlerWithTracker();
      const twinTs = firstSource === "message" ? "1709000000.001777" : "1709000000.001778";
      const message = createMessage({ ts: twinTs, text: "<@UBOT> hello" });
      const handleTwin = (source: "message" | "app_mention") =>
        handler(message, {
          source,
          awaitDispatch: true,
          ...(source === "app_mention" ? { wasMentioned: true } : {}),
        });

      const first = handleTwin(firstSource);
      const second = handleTwin(secondSource);
      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(2));

      const entries = enqueueMock.mock.calls.map((call) => call[0]) as Array<
        Record<string, unknown>
      >;
      await runOnFlush(entries);

      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(prepareSlackMessageMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: expect.objectContaining({ text: message.text, ts: twinTs }),
          opts: expect.objectContaining({ source: "app_mention", wasMentioned: true }),
        }),
      );
      expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
      const prepared = dispatchPreparedSlackMessageMock.mock.calls[0]?.[0] as {
        ctxPayload: { MessageSids?: string[] };
      };
      expect(prepared.ctxPayload.MessageSids).toBeUndefined();
    },
  );

  it("prepares a denied message/app_mention twin pair once without dispatching", async () => {
    prepareSlackMessageMock.mockImplementationOnce(async (params) => {
      params?.opts.onVisibleDrop?.();
      return null;
    });
    const { handler } = createHandlerWithTracker();
    const message = createMessage({ ts: "1709000000.001881", text: "<@UBOT> hello" });
    const asMessage = handler(message, {
      source: "message",
      awaitDispatch: true,
    });
    const asMention = handler(message, {
      source: "app_mention",
      wasMentioned: true,
      awaitDispatch: true,
    });
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(2));

    const entries = enqueueMock.mock.calls.map((call) => call[0]) as Array<Record<string, unknown>>;
    await runOnFlush(entries);
    await expect(Promise.all([asMessage, asMention])).resolves.toEqual([undefined, undefined]);

    expect(prepareSlackMessageMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        opts: expect.objectContaining({ source: "app_mention", wasMentioned: true }),
      }),
    );
    expect(dispatchPreparedSlackMessageMock).not.toHaveBeenCalled();
  });

  it("does not repeat a visible denial for a later message/app_mention twin", async () => {
    prepareSlackMessageMock.mockImplementationOnce(async (params) => {
      params?.opts.onVisibleDrop?.();
      return null;
    });
    const { handler } = createHandlerWithTracker();
    const message = createMessage({ ts: "1709000000.001882", text: "<@UBOT> hello" });

    const asMessage = handler(message, {
      source: "message",
      awaitDispatch: true,
    });
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const first = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await runOnFlush([first]);
    await asMessage;

    const asMention = handler(message, {
      source: "app_mention",
      wasMentioned: true,
      awaitDispatch: true,
    });
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(2));
    const second = enqueueMock.mock.calls[1]?.[0] as Record<string, unknown>;
    await runOnFlush([second]);
    await asMention;

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchPreparedSlackMessageMock).not.toHaveBeenCalled();
  });

  it("preserves distinct messages and identities in the same debounced flush", async () => {
    const { handler } = createHandlerWithTracker();
    const messages = [
      { ts: "1709000000.001779", text: "first message" },
      { ts: "1709000000.001780", text: "second message" },
    ] as const;
    const handled = messages.map((message) =>
      handler(createMessage({ channel: "D111", ...message }), {
        source: "message",
        awaitDispatch: true,
      }),
    );
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(2));

    const entries = enqueueMock.mock.calls.map((call) => call[0]) as Array<Record<string, unknown>>;
    await runOnFlush(entries);

    await expect(Promise.all(handled)).resolves.toEqual([undefined, undefined]);
    expect(prepareSlackMessageMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.objectContaining({ text: "first message\nsecond message" }),
      }),
    );
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
    const prepared = dispatchPreparedSlackMessageMock.mock.calls[0]?.[0] as {
      ctxPayload: {
        MessageSids?: string[];
        MessageSidFirst?: string;
        MessageSidLast?: string;
      };
    };
    expect(prepared.ctxPayload).toMatchObject({
      MessageSids: [messages[0].ts, messages[1].ts],
      MessageSidFirst: messages[0].ts,
      MessageSidLast: messages[1].ts,
    });
  });

  it("propagates debounced dispatch failures to relay delivery", async () => {
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(new Error("dispatch failed"));
    const { handler } = createHandlerWithTracker();
    const handled = handler(createMessage({ ts: "1709000000.000600", text: "relay message" }), {
      source: "message",
      awaitDispatch: true,
    });

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const handledFailure = expect(handled).rejects.toThrow("dispatch failed");
    const flushFailure = expect(runOnFlush([entry])).rejects.toThrow("dispatch failed");
    await Promise.all([handledFailure, flushFailure]);
  });

  it("retains the admitted batch config across native session conflict retries", async () => {
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", {
        cause: new Error(
          "reply session initialization conflicted for agent:main:main:thread:123.456",
        ),
      }),
    );
    const cfg: OpenClawConfig = { messages: { ackReactionScope: "off" } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const { handler } = createHandlerWithTracker({ cfg });
    await handler(createMessage({ ts: "1709000000.000700", text: "native message" }), {
      source: "message",
    });

    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    enqueueMock.mockImplementation(async (retry) => runOnFlush([retry as Record<string, unknown>]));
    vi.useFakeTimers();
    try {
      const flush = runOnFlush([entry]).then(
        () => "completed",
        () => "failed",
      );
      await vi.advanceTimersByTimeAsync(0);
      const next: OpenClawConfig = { messages: { ackReactionScope: "all" } };
      setRuntimeConfigSnapshot(next, next);
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        prepareSlackMessageMock.mock.calls.map(
          ([params]) => params?.ctx.cfg.messages?.ackReactionScope,
        ),
      ).toEqual(["off", "off"]);
      expect(await flush).toBe("completed");
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      enqueueMock.mockImplementation(async () => {});
    }
  });

  it("keeps later same-key messages behind a retry with the original policy", async () => {
    useRealDebouncer = true;
    const cfg: OpenClawConfig = { messages: { ackReactionScope: "off" } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const abort = new AbortController();
    const { handler } = createHandlerWithTracker({ cfg, abortSignal: abort.signal });
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("reply session initialization conflicted for agent:main:main"),
    );
    const message: Parameters<typeof handler>[0] = {
      type: "message",
      channel: "D1",
      user: "U1",
      ts: "123.001",
      text: "first",
    };
    vi.useFakeTimers();
    try {
      const first = handler(message, { source: "message" });
      await vi.advanceTimersByTimeAsync(0);
      expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
      const next: OpenClawConfig = { messages: { ackReactionScope: "all" } };
      setRuntimeConfigSnapshot(next, next);
      const second = handler({ ...message, ts: "123.002", text: "second" }, { source: "message" });
      await vi.advanceTimersByTimeAsync(0);
      expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([first, second]);
      expect(
        prepareSlackMessageMock.mock.calls.map(
          ([params]) => params?.ctx.cfg.messages?.ackReactionScope,
        ),
      ).toEqual(["off", "off", "all"]);
    } finally {
      abort.abort();
      await Promise.all(realDebouncers.map((debouncer) => debouncer.drain()));
      vi.useRealTimers();
    }
  });

  it.each(["stop", "exhaust"] as const)("settles native retry ownership on %s", async (outcome) => {
    useRealDebouncer = true;
    const abort = new AbortController();
    const { handler, ctx } = createHandlerWithTracker({ abortSignal: abort.signal });
    const onError = vi.fn();
    ctx.runtime.error = onError;
    for (let attempt = 0; attempt < (outcome === "stop" ? 1 : 4); attempt += 1) {
      dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
        new Error("reply session initialization conflicted for agent:main:main"),
      );
    }
    vi.useFakeTimers();
    try {
      const handled = handler(
        createMessage({ channel: "D1", user: "U1", ts: "123.003", text: "retry" }),
        {
          source: "message",
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
      if (outcome === "stop") {
        abort.abort(new Error("monitor stopped"));
      }
      await vi.advanceTimersByTimeAsync(3000);
      await handled;
      await Promise.all(realDebouncers.map((debouncer) => debouncer.drain()));
      expect(prepareSlackMessageMock).toHaveBeenCalledTimes(outcome === "stop" ? 1 : 4);
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          outcome === "stop" ? "aborted" : "reply session initialization conflicted",
        ),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      abort.abort();
      await Promise.all(realDebouncers.map((debouncer) => debouncer.drain()));
      vi.useRealTimers();
    }
  });

  it("leaves relay session conflict retries to unacknowledged redelivery", async () => {
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", {
        cause: new Error(
          "reply session initialization conflicted for agent:main:main:thread:123.456",
        ),
      }),
    );
    const { handler } = createHandlerWithTracker();
    const handled = handler(createMessage({ ts: "1709000000.000800", text: "relay message" }), {
      source: "message",
      awaitDispatch: true,
    });

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    vi.useFakeTimers();
    try {
      const handledFailure = expect(handled).rejects.toThrow("Slack dispatch failed");
      const flushFailure = expect(runOnFlush([entry])).rejects.toThrow("Slack dispatch failed");
      await Promise.all([handledFailure, flushFailure]);
      await vi.advanceTimersByTimeAsync(1000);

      expect(enqueueMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
