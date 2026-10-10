// Slack tests cover message handler plugin behavior.
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeRetryBackoffs } from "./message-handler.retry.test-support.js";
import { buildSlackDebounceKey } from "./message-handler/debounce-key.js";
import { createInboundSlackTestContext } from "./message-handler/prepare.test-helpers.js";

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
    opts: { onVisibleDrop?: () => void };
  }): Promise<{
    ctxPayload: Record<string, unknown>;
    route?: { sessionKey: string };
  } | null> => ({ ctxPayload: {} }),
);
const dispatchPreparedSlackMessageMock = vi.fn(async (_prepared: unknown) => {});
const resolveThreadTsMock = vi.fn(async ({ message }: { message: Record<string, unknown> }) => ({
  ...message,
}));
const { createSlackRuntimeContextReader } = await import("./runtime-policy.js");
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

function createContext(overrides?: {
  cfg?: OpenClawConfig;
  rememberSlackChannelType?: (
    channel: string | null | undefined,
    channelType: string | null | undefined,
  ) => void;
}) {
  const ctx = {
    installationIdentity: { kind: "degraded", reason: "auth_test_failed" },
    cfg: overrides?.cfg ?? {},
    accountId: "default",
    app: {
      client: {},
    },
    runtime: {},
    rememberSlackChannelType: (
      channel: string | null | undefined,
      channelType: string | null | undefined,
    ) => overrides?.rememberSlackChannelType?.(channel, channelType),
  } as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
  ctx.readRuntimeContext = createSlackRuntimeContextReader(ctx, "synthetic-lookup");
  return ctx;
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
    trackEvent,
  });
  return { handler, trackEvent, ctx };
}

describe("createSlackMessageHandler", () => {
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

  it("keeps each in-flight message on its captured config snapshot", async () => {
    const startupConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "max" } } };
    const firstConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "high" } } };
    const secondConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "ultra" } } };
    setRuntimeConfigSnapshot(startupConfig, startupConfig);
    const context = createContext({ cfg: startupConfig });
    const handler = createSlackMessageHandler({
      ctx: context,
    });
    let releaseFirstPreparation!: () => void;
    const firstPreparation = new Promise<void>((resolve) => {
      releaseFirstPreparation = resolve;
    });
    prepareSlackMessageMock.mockImplementationOnce(async () => {
      await firstPreparation;
      return { ctxPayload: {} };
    });

    setRuntimeConfigSnapshot(firstConfig, firstConfig);
    await handler(
      {
        type: "message",
        channel: "D1",
        user: "U1",
        ts: "1709000000.009002",
        text: "first",
      } as never,
      { source: "message" },
    );
    const firstEntry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const firstFlush = runOnFlush([firstEntry]);
    await vi.waitFor(() => expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1));

    setRuntimeConfigSnapshot(secondConfig, secondConfig);
    await handler(
      {
        type: "message",
        channel: "D2",
        user: "U2",
        ts: "1709000000.009003",
        text: "second",
      } as never,
      { source: "message" },
    );
    const secondEntry = enqueueMock.mock.calls[1]?.[0] as Record<string, unknown>;
    await runOnFlush([secondEntry]);
    releaseFirstPreparation();
    await firstFlush;

    expect(prepareSlackMessageMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ctx: expect.objectContaining({ cfg: firstConfig }) }),
    );
    expect(prepareSlackMessageMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ctx: expect.objectContaining({ cfg: secondConfig }) }),
    );
    expect(context.cfg).toBe(startupConfig);
  });

  it("does not track invalid non-message events from the message stream", async () => {
    const trackEvent = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      trackEvent,
    });

    await handler(
      {
        type: "reaction_added",
        channel: "D1",
        ts: "123.456",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("records explicit channel type before thread resolution", async () => {
    let settleThreadResolution: (() => void) | undefined;
    resolveThreadTsMock.mockImplementationOnce(
      async ({ message }: { message: Record<string, unknown> }) => {
        await new Promise<void>((resolve) => {
          settleThreadResolution = resolve;
        });
        return { ...message };
      },
    );
    const rememberSlackChannelType = vi.fn();
    const { handler } = createHandlerWithTracker({ rememberSlackChannelType });
    const handled = handler(
      {
        type: "message",
        channel: "C0MPDM42",
        channel_type: "mpim",
        user: "U_HUMAN",
        ts: "123.456",
        text: "human seed",
      } as never,
      { source: "message" },
    );

    expect(rememberSlackChannelType).toHaveBeenCalledWith("C0MPDM42", "mpim");
    expect(enqueueMock).not.toHaveBeenCalled();
    settleThreadResolution?.();
    await handled;
    expect(enqueueMock).toHaveBeenCalledOnce();
  });

  it("drops message subtypes that do not carry user message text", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handler(
      {
        type: "message",
        subtype: "channel_join",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000400",
        text: "<@U111> joined the channel",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("flushes buffered text before a table-bearing message", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext({ cfg: { messages: { inbound: { debounceMs: 10 } } } }),
    });

    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000100",
        text: "first buffered text",
      } as never,
      { source: "message" },
    );
    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000200",
        text: "table follows",
        attachments: [
          {
            blocks: [
              {
                type: "table",
                rows: [[{ type: "raw_text", text: "kept" }]],
              },
            ],
          },
        ],
      } as never,
      { source: "message" },
    );

    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
  });

  it("retires a buffered key when replay filtering drops every entry", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext({ cfg: { messages: { inbound: { debounceMs: 10 } } } }),
    });
    const bufferedMessage = {
      type: "message" as const,
      channel: "C111",
      user: "U111",
      ts: "1709000000.000300",
      text: "duplicate buffered text",
    };

    await handler(bufferedMessage as never, { source: "message" });
    const first = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await runOnFlush([first]);

    await handler(bufferedMessage as never, { source: "message" });
    const duplicate = enqueueMock.mock.calls[1]?.[0] as Record<string, unknown>;
    await runOnFlush([duplicate]);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
    flushKeyMock.mockClear();

    await handler(
      {
        type: "message",
        subtype: "file_share",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000400",
        text: "file follows",
        files: [{ id: "F1" }],
      } as never,
      { source: "message" },
    );

    expect(flushKeyMock).not.toHaveBeenCalled();
  });

  it("carries durable ingress ownership into prepared dispatch", async () => {
    prepareSlackMessageMock.mockResolvedValueOnce({
      ctxPayload: {},
      route: { sessionKey: "agent:main:slack:channel:C111" },
    });
    const turnAdoptionLifecycle = {
      admission: "exclusive" as const,
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
      onSessionRouted: vi.fn(async () => {}),
    };
    const { handler } = createHandlerWithTracker();
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000550",
        text: "durable message",
      } as never,
      { source: "message", awaitDispatch: true, turnAdoptionLifecycle },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    expect(resolveThreadTsMock).toHaveBeenCalledWith({
      message: expect.objectContaining({ channel: "C111", ts: "1709000000.000550" }),
      source: "message",
      turnAdoptionLifecycle,
    });
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    let settled = false;
    void handled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await runOnFlush([entry]);
    await expect(handled).resolves.toBeUndefined();

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

  it("deduplicates twins in one flush while preserving the earlier app_mention", async () => {
    const firstSource = "app_mention";
    const secondSource = "message";
    const { handler } = createHandlerWithTracker();
    const twinTs = "1709000000.001778";
    const message = {
      type: "message" as const,
      channel: "C111",
      user: "U111",
      ts: twinTs,
      text: "<@UBOT> hello",
    };
    const handleTwin = (source: "message" | "app_mention") =>
      handler(message as never, {
        source,
        awaitDispatch: true,
        ...(source === "app_mention" ? { wasMentioned: true } : {}),
      });

    const first = handleTwin(firstSource);
    const second = handleTwin(secondSource);
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(2));

    await runOnFlush(enqueueMock.mock.calls.map(([entry]) => entry as Record<string, unknown>));

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
  });

  it("prepares a denied message/app_mention twin pair once without dispatching", async () => {
    prepareSlackMessageMock.mockImplementationOnce(async (params) => {
      params?.opts.onVisibleDrop?.();
      return null;
    });
    const { handler } = createHandlerWithTracker();
    const message = {
      type: "message" as const,
      channel: "C111",
      user: "U111",
      ts: "1709000000.001881",
      text: "<@UBOT> hello",
    };
    const asMessage = handler(message as never, {
      source: "message",
      awaitDispatch: true,
    });
    const asMention = handler(message as never, {
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

  it.each(["verified", "asserted"] as const)(
    "preserves coalesced messages and %s sender assurance",
    async (authentication) => {
      const { handler } = createHandlerWithTracker();
      const messages = [
        { ts: "1709000000.001779", text: "first message" },
        { ts: "1709000000.001780", text: "second message" },
      ] as const;
      const handled = messages.map((message, index) =>
        handler(
          {
            type: "message",
            channel: authentication === "verified" ? "D111" : "D112",
            user: "U111",
            ...message,
          } as never,
          { source: "message", senderAuthentication: index === 0 ? authentication : "verified" },
        ),
      );
      await expect(Promise.all(handled)).resolves.toEqual([undefined, undefined]);
      expect(enqueueMock).toHaveBeenCalledTimes(2);

      const entries = enqueueMock.mock.calls.map((call) => call[0]) as Array<
        Record<string, unknown>
      >;
      await runOnFlush(entries);

      expect(prepareSlackMessageMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: expect.objectContaining({ text: "first message\nsecond message" }),
          opts: expect.objectContaining({ senderAuthentication: authentication }),
        }),
      );
      expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ctxPayload: expect.objectContaining({
            MessageSids: [messages[0].ts, messages[1].ts],
            MessageSidFirst: messages[0].ts,
            MessageSidLast: messages[1].ts,
          }),
        }),
      );
    },
  );

  it("keeps later same-key messages behind a retry with the original policy", async () => {
    useRealDebouncer = true;
    const cfg: OpenClawConfig = { messages: { ackReactionScope: "off" } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const abort = new AbortController();
    const { handler } = createHandlerWithTracker({ cfg, abortSignal: abort.signal });
    const backoffs = observeRetryBackoffs(1);
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
      await backoffs.entered[0]!.promise;
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
      backoffs.restore();
      vi.useRealTimers();
    }
  });

  it.each(["stop", "exhaust"] as const)("settles native retry ownership on %s", async (outcome) => {
    useRealDebouncer = true;
    const abort = new AbortController();
    const { handler, ctx } = createHandlerWithTracker({ abortSignal: abort.signal });
    const onError = vi.fn();
    ctx.runtime.error = onError;
    const backoffs = observeRetryBackoffs(outcome === "stop" ? 1 : 3);
    for (let attempt = 0; attempt < (outcome === "stop" ? 1 : 4); attempt += 1) {
      dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
        new Error("reply session initialization conflicted for agent:main:main"),
      );
    }
    vi.useFakeTimers();
    try {
      const handled = handler(
        { type: "message", channel: "D1", user: "U1", ts: "123.003", text: "retry" },
        { source: "message" },
      );
      await backoffs.entered[0]!.promise;
      expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
      if (outcome === "stop") {
        abort.abort(new Error("monitor stopped"));
      }
      if (outcome === "exhaust") {
        for (const backoff of backoffs.entered) {
          await backoff.promise;
          await vi.advanceTimersByTimeAsync(1000);
        }
      }
      await handled;
      await Promise.all(realDebouncers.map((debouncer) => debouncer.drain()));
      expect(prepareSlackMessageMock).toHaveBeenCalledTimes(outcome === "stop" ? 1 : 4);
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          outcome === "stop" ? "aborted" : "reply session initialization conflicted",
        ),
      );
      await closeOpenClawStateDatabaseAsync();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      abort.abort();
      await Promise.all(realDebouncers.map((debouncer) => debouncer.drain()));
      backoffs.restore();
      vi.useRealTimers();
    }
  });

  it("releases every acquired claim when cancellation interrupts the next claim", async () => {
    const controller = new AbortController();
    const pending = createDeferred<{
      kind: "claimed";
      handle: { keys: readonly [string]; commit: () => Promise<boolean>; release: () => void };
    }>();
    const first = { keys: ["first"] as const, commit: vi.fn(async () => true), release: vi.fn() };
    const second = { keys: ["second"] as const, commit: vi.fn(async () => true), release: vi.fn() };
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ kind: "claimed", handle: first })
      .mockReturnValueOnce(pending.promise);
    const { createChannelReplayGuard } = await import("openclaw/plugin-sdk/persistent-dedupe");
    const guard = createChannelReplayGuard<{ keys: readonly string[] }>({
      dedupe: { ttlMs: 0, memoryMaxSize: 10 },
      buildReplayKey: (event) => event.keys,
    });
    guard.claim = claim;
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      abortSignal: controller.signal,
      dispatchReplayGuard: guard,
    });
    for (const ts of ["1709000000.004001", "1709000000.004002"]) {
      await handler(
        { type: "message", channel: "C_TEST", user: "U_TEST", ts, text: "hello" },
        { source: "message" },
      );
    }
    const entries = enqueueMock.mock.calls.map(([entry]) => entry).filter(isRecord);
    expect(entries).toHaveLength(2);
    const flushing = runOnFlush(entries);
    const rejected = expect(flushing).rejects.toThrow("cancelled during claim");
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    controller.abort(new Error("cancelled during claim"));
    pending.resolve({ kind: "claimed", handle: second });
    await rejected;
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).toHaveBeenCalledOnce();
    expect(first.commit).not.toHaveBeenCalled();
    expect(second.commit).not.toHaveBeenCalled();
    expect(prepareSlackMessageMock).not.toHaveBeenCalled();
    expect(dispatchPreparedSlackMessageMock).not.toHaveBeenCalled();
  });

  it("defers ingress before waiting for a duplicate's dispatch claim", async () => {
    const duplicate = createDeferred<boolean>();
    const onDispatchWaiting = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext(),
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

  it("settles rejected policy admission and dispatches after configuration is repaired", async () => {
    useRealDebouncer = true;
    const cfg: OpenClawConfig = {
      channels: { slack: { dmPolicy: "allowlist", allowFrom: ["U12345678"] } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const ctx = createInboundSlackTestContext({ cfg });
    ctx.installationIdentity = { kind: "enterprise", enterpriseId: "E12345678" };
    const onError = vi.fn();
    ctx.runtime.error = onError;
    const handler = createSlackMessageHandler({ ctx });
    const invalid: OpenClawConfig = {
      channels: { slack: { dmPolicy: "allowlist", allowFrom: ["@invalid-name"] } },
    };
    setRuntimeConfigSnapshot(invalid, invalid);
    const message = {
      type: "message" as const,
      channel: "D12345678",
      channel_type: "im" as const,
      user: "U12345678",
      ts: "300.001",
      text: "hello",
    };
    let failure: unknown;
    const rejected = handler(message, { source: "message", awaitDispatch: true }).catch(
      (error: unknown) => {
        failure = error;
      },
    );
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(failure).toEqual(
        expect.objectContaining({ message: expect.stringContaining("stable Slack IDs") }),
      ),
    );
    await rejected;
    expect(prepareSlackMessageMock).not.toHaveBeenCalled();
    expect(dispatchPreparedSlackMessageMock).not.toHaveBeenCalled();

    setRuntimeConfigSnapshot(cfg, cfg);
    await handler({ ...message, ts: "300.002" }, { source: "message", awaitDispatch: true });
    expect(prepareSlackMessageMock).toHaveBeenCalledOnce();
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledOnce();
  });

  it("isolates unresolved thread replies from top-level debounce keys", () => {
    expect(
      buildSlackDebounceKey(
        {
          type: "message",
          channel: "C123",
          user: "U456",
          parent_user_id: "U789",
          ts: "1709000000.000200",
          text: "hello",
        },
        "default",
      ),
    ).toBe("slack:default:C123:maybe-thread:1709000000.000200:U456");
  });

  it("falls back to the channel when no timestamp is available", () => {
    expect(
      buildSlackDebounceKey(
        {
          type: "message",
          channel: "C123",
          user: "U456",
          text: "hello",
        },
        "default",
      ),
    ).toBe("slack:default:C123:U456");
  });
});
