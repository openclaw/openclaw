import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import { buildSlackDebounceKey } from "./message-handler/debounce-key.js";
import { createInboundSlackTestContext } from "./message-handler/prepare.test-helpers.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";

type HandlerParams = Parameters<typeof createSlackMessageHandler>[0];
type DispatchReplayGuard = NonNullable<HandlerParams["dispatchReplayGuard"]>;

function makeMessage(
  ts: string,
  text: string,
  overrides: Partial<SlackMessageEvent> = {},
): SlackMessageEvent {
  return { type: "message", channel: "C111", user: "U111", ts, text, ...overrides };
}

function expectPrepared(
  message: Partial<SlackMessageEvent> | undefined,
  opts: Record<string, unknown>,
) {
  expect(prepareMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      ...(message ? { message: expect.objectContaining(message) } : {}),
      opts: expect.objectContaining(opts),
    }),
  );
}

function queuedEntries() {
  return enqueueMock.mock.calls.map(([entry]) => entry);
}

let useRealDebouncer = false;
const enqueueMock = vi.fn(async (_entry: Record<string, unknown>) => {});
const flushKeyMock = vi.fn(async (_key: string) => {});
type DebouncerFactory =
  typeof import("openclaw/plugin-sdk/channel-inbound").createChannelInboundDebouncer<
    Record<string, unknown>
  >;
const onFlushCallbacks: Array<Parameters<DebouncerFactory>[0]["onFlush"]> = [];
const prepareMock = vi.fn(
  async (_params?: {
    ctx: HandlerParams["ctx"];
    opts: { onVisibleDrop?: () => void };
  }): Promise<{
    ctxPayload: Record<string, unknown>;
    route?: { sessionKey: string };
  } | null> => ({ ctxPayload: {} }),
);
const dispatchMock = vi.fn(async (_prepared: PreparedSlackMessage) => {});
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
        return actual.createChannelInboundDebouncer(params);
      }
      return {
        debounceMs: 10,
        debouncer: {
          enqueue: (entry: Record<string, unknown>) => enqueueMock(entry),
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

// mock-isolation: Exercise debounce and adoption dispatch without a real agent run or channel send.
vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepareMock,
  dispatchPreparedSlackMessage: dispatchMock,
}));

type HandlerOverrides = Pick<HandlerParams, "abortSignal" | "dispatchReplayGuard"> & {
  cfg?: OpenClawConfig;
  rememberSlackChannelType?: HandlerParams["ctx"]["rememberSlackChannelType"];
};

function createContext(overrides?: HandlerOverrides) {
  const ctx = {
    installationIdentity: { kind: "degraded", reason: "auth_test_failed" },
    cfg: overrides?.cfg ?? {},
    accountId: "default",
    app: { client: {} },
    runtime: {},
    rememberSlackChannelType: (
      channel: string | null | undefined,
      channelType: string | null | undefined,
    ) => overrides?.rememberSlackChannelType?.(channel, channelType),
  } as HandlerParams["ctx"];
  ctx.readRuntimeContext = createSlackRuntimeContextReader(ctx, "synthetic-lookup");
  return ctx;
}

function createHandlerWithTracker(overrides?: HandlerOverrides) {
  const trackEvent = vi.fn();
  const ctx = createContext(overrides);
  const handler = createSlackMessageHandler({
    ctx,
    abortSignal: overrides?.abortSignal,
    dispatchReplayGuard: overrides?.dispatchReplayGuard,
    trackEvent,
  });
  return { handler, trackEvent, ctx };
}

describe("createSlackMessageHandler", () => {
  beforeEach(() => {
    useRealDebouncer = false;
    clearRuntimeConfigSnapshot();
    enqueueMock.mockClear();
    flushKeyMock.mockClear();
    onFlushCallbacks.length = 0;
    prepareMock.mockClear();
    dispatchMock.mockClear();
    resolveThreadTsMock.mockClear();
  });

  afterEach(clearRuntimeConfigSnapshot);

  it("keeps each in-flight message on its captured config snapshot", async () => {
    const startupConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "max" } } };
    const firstConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "high" } } };
    const secondConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "ultra" } } };
    setRuntimeConfigSnapshot(startupConfig, startupConfig);
    const context = createContext({ cfg: startupConfig });
    const handler = createSlackMessageHandler({
      ctx: context,
    });
    const firstPreparation = createDeferred<void>();
    prepareMock.mockImplementationOnce(async () => {
      await firstPreparation.promise;
      return { ctxPayload: {} };
    });

    setRuntimeConfigSnapshot(firstConfig, firstConfig);
    await handler(makeMessage("1709000000.009002", "first", { channel: "D1", user: "U1" }), {
      source: "message",
    });
    const firstEntry = queuedEntries()[0]!;
    const firstFlush = runOnFlush([firstEntry]);
    await vi.waitFor(() => expect(prepareMock).toHaveBeenCalledTimes(1));

    setRuntimeConfigSnapshot(secondConfig, secondConfig);
    await handler(makeMessage("1709000000.009003", "second", { channel: "D2", user: "U2" }), {
      source: "message",
    });
    const secondEntry = queuedEntries()[1]!;
    await runOnFlush([secondEntry]);
    firstPreparation.resolve();
    await firstFlush;

    expect(prepareMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ctx: expect.objectContaining({ cfg: firstConfig }) }),
    );
    expect(prepareMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ctx: expect.objectContaining({ cfg: secondConfig }) }),
    );
    expect(context.cfg).toBe(startupConfig);
  });

  it.each([
    { type: "reaction_added", channel: "D1", ts: "123.456" },
    makeMessage("1709000000.000400", "<@U111> joined the channel", {
      subtype: "channel_join",
      channel: "C111",
      user: "U111",
    }),
  ])("does not track or enqueue non-user events: $type $subtype", async (message) => {
    const { handler, trackEvent } = createHandlerWithTracker();
    await handler(message as never, { source: "message" });
    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("records explicit channel type before thread resolution", async () => {
    const threadResolution = createDeferred<void>();
    resolveThreadTsMock.mockImplementationOnce(
      async ({ message }: { message: Record<string, unknown> }) => {
        await threadResolution.promise;
        return { ...message };
      },
    );
    const rememberSlackChannelType = vi.fn();
    const { handler } = createHandlerWithTracker({ rememberSlackChannelType });
    const handled = handler(
      makeMessage("123.456", "human seed", {
        channel: "C0MPDM42",
        channel_type: "mpim",
        user: "U_HUMAN",
      }),
      { source: "message" },
    );

    expect(rememberSlackChannelType).toHaveBeenCalledWith("C0MPDM42", "mpim");
    expect(enqueueMock).not.toHaveBeenCalled();
    threadResolution.resolve();
    await handled;
    expect(enqueueMock).toHaveBeenCalledOnce();
  });

  it("flushes buffered text before a table-bearing message", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext({ cfg: { messages: { inbound: { debounceMs: 10 } } } }),
    });

    await handler(makeMessage("1709000000.000100", "first buffered text"), { source: "message" });
    await handler(
      makeMessage("1709000000.000200", "table follows", {
        attachments: [
          { blocks: [{ type: "table", rows: [[{ type: "raw_text", text: "kept" }]] }] },
        ],
      }),
      { source: "message" },
    );

    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
  });

  it("retires a buffered key when replay filtering drops every entry", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext({ cfg: { messages: { inbound: { debounceMs: 10 } } } }),
    });
    const bufferedMessage = makeMessage("1709000000.000300", "duplicate buffered text");

    await handler(bufferedMessage as never, { source: "message" });
    const first = queuedEntries()[0]!;
    await runOnFlush([first]);

    await handler(bufferedMessage as never, { source: "message" });
    const duplicate = queuedEntries()[1]!;
    await runOnFlush([duplicate]);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    flushKeyMock.mockClear();

    await handler(
      makeMessage("1709000000.000400", "file follows", {
        subtype: "file_share",
        files: [{ id: "F1" }],
      }),
      { source: "message" },
    );

    expect(flushKeyMock).not.toHaveBeenCalled();
  });

  it("carries durable ingress ownership into prepared dispatch", async () => {
    prepareMock.mockResolvedValueOnce({
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
    const handled = handler(makeMessage("1709000000.000550", "durable message"), {
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
    const entry = queuedEntries()[0]!;
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
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(turnAdoptionLifecycle.onSessionRouted).toHaveBeenCalledExactlyOnceWith(
      "agent:main:slack:channel:C111",
    );
    expect(turnAdoptionLifecycle.onSessionRouted.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchMock.mock.invocationCallOrder[0] ?? 0,
    );
    const prepared = dispatchMock.mock.calls[0]![0];
    expect(prepared.turnAdoptionLifecycle?.admission).toBe("exclusive");
    expect(prepared.turnAdoptionLifecycle?.abortSignal).toBe(turnAdoptionLifecycle.abortSignal);
    await prepared.turnAdoptionLifecycle?.onAdopted();
    expect(turnAdoptionLifecycle.onAdopted).toHaveBeenCalledTimes(1);
    prepared.turnAdoptionLifecycle?.onDeferred?.();
    expect(turnAdoptionLifecycle.onDeferred).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "prepares twins once and dispatches only when allowed (denied=%s)",
    async (denied) => {
      if (denied) {
        prepareMock.mockImplementationOnce(async (params) => {
          params?.opts.onVisibleDrop?.();
          return null;
        });
      }
      const { handler } = createHandlerWithTracker();
      const twinTs = denied ? "1709000000.001881" : "1709000000.001778";
      const message = makeMessage(twinTs, "<@UBOT> hello");
      const handleTwin = (source: "message" | "app_mention") =>
        handler(message as never, {
          source,
          awaitDispatch: true,
          ...(source === "app_mention" ? { wasMentioned: true } : {}),
        });

      const first = handleTwin(denied ? "message" : "app_mention");
      const second = handleTwin(denied ? "app_mention" : "message");
      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(2));

      await runOnFlush(queuedEntries());

      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expectPrepared(denied ? undefined : { text: message.text, ts: twinTs }, {
        source: "app_mention",
        wasMentioned: true,
      });
      expect(dispatchMock).toHaveBeenCalledTimes(denied ? 0 : 1);
      if (!denied) {
        expect(dispatchMock.mock.calls[0]![0].ctxPayload.MessageSids).toBeUndefined();
      }
    },
  );

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

      const entries = queuedEntries();
      await runOnFlush(entries);

      expectPrepared(
        { text: "first message\nsecond message" },
        { senderAuthentication: authentication },
      );
      expect(dispatchMock).toHaveBeenCalledExactlyOnceWith(
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
    const { handler } = createHandlerWithTracker({
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
    expect(prepareMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("defers ingress before waiting for a duplicate's dispatch claim", async () => {
    const duplicate = createDeferred<boolean>();
    const onDispatchWaiting = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      dispatchReplayGuard: {
        claim: async () => ({ kind: "inflight", pending: duplicate.promise }),
      } as unknown as DispatchReplayGuard,
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
      expect(prepareMock).not.toHaveBeenCalled();
    } finally {
      duplicate.resolve(true);
      await admission;
      await debouncer.drain();
      await handled;
    }
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("requeues a released twin and releases other claims from its flush", async () => {
    const owner = createDeferred<boolean>();
    const release = vi.fn();
    const claim = vi
      .fn()
      .mockResolvedValue({ kind: "claimed", handle: { commit: vi.fn(), release: vi.fn() } })
      .mockResolvedValueOnce({ kind: "claimed", handle: { commit: vi.fn(), release } })
      .mockResolvedValueOnce({ kind: "inflight", pending: owner.promise });
    const { handler } = createHandlerWithTracker({
      dispatchReplayGuard: { claim } as unknown as DispatchReplayGuard,
    });
    for (const ts of ["1709000000.000701", "1709000000.000702"]) {
      await handler(
        { type: "message", channel: "C111", user: "U111", ts, text: "retry me" } as never,
        { source: "message" },
      );
    }
    const entries = queuedEntries();
    const flushing = runOnFlush(entries);
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    vi.useFakeTimers();
    try {
      owner.reject(new Error("original dispatch failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toHaveBeenCalledOnce();
      expect(claim).toHaveBeenCalledTimes(2);
      expect(prepareMock).not.toHaveBeenCalled();
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
    const message = makeMessage("300.001", "hello", {
      channel: "D12345678",
      channel_type: "im" as const,
      user: "U12345678",
    });
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
    expect(prepareMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();

    setRuntimeConfigSnapshot(cfg, cfg);
    await handler({ ...message, ts: "300.002" }, { source: "message", awaitDispatch: true });
    expect(prepareMock).toHaveBeenCalledOnce();
    expect(dispatchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [
      makeMessage("1709000000.000200", "hello", {
        channel: "C123",
        user: "U456",
        parent_user_id: "U789",
      }),
      "slack:default:C123:maybe-thread:1709000000.000200:U456",
    ],
    [
      { type: "message", channel: "C123", user: "U456", text: "hello" } satisfies SlackMessageEvent,
      "slack:default:C123:U456",
    ],
  ] as const)("isolates debounce key %s", (message, key) => {
    expect(buildSlackDebounceKey(message, "default")).toBe(key);
  });
});
