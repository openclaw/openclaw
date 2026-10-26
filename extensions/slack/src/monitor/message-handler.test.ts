import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import * as dedupe from "./message-dispatch-dedupe.js";
import { buildSlackDebounceKey } from "./message-handler/debounce-key.js";
import { createInboundSlackTestContext } from "./message-handler/prepare.test-helpers.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";

type HandlerParams = Parameters<typeof createSlackMessageHandler>[0];
type DispatchReplayGuard = ReturnType<typeof dedupe.createSlackMessageDispatchReplayGuard>;

function makeMessage(
  ts: string,
  text = "hello",
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

function testHandler({ cfg, rememberSlackChannelType, ...params }: HandlerOverrides = {}) {
  const handler = createSlackMessageHandler({
    ...params,
    ctx: params.ctx ?? createContext({ cfg, rememberSlackChannelType }),
  });
  return (message: SlackMessageEvent, opts: Partial<Parameters<typeof handler>[1]> = {}) =>
    handler(message, { source: "message", ...opts });
}

function expectUncalled(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function makeClaim(key: string) {
  return { keys: [key] as const, commit: vi.fn(async () => true), release: vi.fn() };
}

function mockReplayGuard(guard: Partial<DispatchReplayGuard>) {
  vi.spyOn(dedupe, "createSlackMessageDispatchReplayGuard").mockReturnValueOnce(
    guard as DispatchReplayGuard,
  );
}

const debouncedConfig = { messages: { inbound: { debounceMs: 10 } } };
const thinkingConfig = (thinkingDefault: "max" | "high" | "ultra"): OpenClawConfig => ({
  agents: { defaults: { thinkingDefault } },
});
const lifecycle = () => ({
  admission: "exclusive" as const,
  abortSignal: new AbortController().signal,
  onAdopted: vi.fn(),
  onDeferred: vi.fn(),
  onAbandoned: vi.fn(),
});

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

function runOnFlush(entries = queuedEntries()): Promise<void> {
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

type HandlerOverrides = Partial<HandlerParams> & {
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
  afterEach(() => vi.restoreAllMocks());

  it("keeps each in-flight message on its captured config snapshot", async () => {
    const startupConfig = thinkingConfig("max");
    const firstConfig = thinkingConfig("high");
    const secondConfig = thinkingConfig("ultra");
    setRuntimeConfigSnapshot(startupConfig, startupConfig);
    const context = createContext({ cfg: startupConfig });
    const handler = testHandler({ ctx: context });
    const firstPreparation = createDeferred<void>();
    prepareMock.mockImplementationOnce(async () => {
      await firstPreparation.promise;
      return { ctxPayload: {} };
    });

    setRuntimeConfigSnapshot(firstConfig, firstConfig);
    await handler(makeMessage("1.9002", "first", { channel: "D1", user: "U1" }));
    const firstFlush = runOnFlush([queuedEntries()[0]!]);
    await vi.waitFor(() => expect(prepareMock).toHaveBeenCalledTimes(1));

    setRuntimeConfigSnapshot(secondConfig, secondConfig);
    await handler(makeMessage("1.9003", "second", { channel: "D2", user: "U2" }));
    await runOnFlush([queuedEntries()[1]!]);
    firstPreparation.resolve();
    await firstFlush;

    expect(prepareMock.mock.calls.map(([params]) => params?.ctx.cfg)).toEqual([
      firstConfig,
      secondConfig,
    ]);
    expect(context.cfg).toBe(startupConfig);
  });

  it.each([
    { type: "reaction_added", channel: "D1", ts: "123.456" },
    makeMessage("1.400", "joined", { subtype: "channel_join" }),
  ])("does not track or enqueue non-user events: $type $subtype", async (message) => {
    const trackEvent = vi.fn();
    const handler = testHandler({ trackEvent });
    await handler(message as never);
    expectUncalled(trackEvent, resolveThreadTsMock, enqueueMock);
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
    const handler = testHandler({ rememberSlackChannelType });
    const handled = handler(
      makeMessage("123.456", "human seed", {
        channel: "C0MPDM42",
        channel_type: "mpim",
        user: "U_HUMAN",
      }),
    );

    expect(rememberSlackChannelType).toHaveBeenCalledWith("C0MPDM42", "mpim");
    expect(enqueueMock).not.toHaveBeenCalled();
    threadResolution.resolve();
    await handled;
    expect(enqueueMock).toHaveBeenCalledOnce();
  });

  it("flushes buffered text before a table-bearing message", async () => {
    const handler = testHandler({ cfg: debouncedConfig });

    await handler(makeMessage("1.100"));
    await handler(
      makeMessage("1.200", "table", {
        attachments: [
          { blocks: [{ type: "table", rows: [[{ type: "raw_text", text: "kept" }]] }] },
        ],
      }),
    );

    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1.100:U111");
  });

  it("retires a buffered key when replay filtering drops every entry", async () => {
    const handler = testHandler({ cfg: debouncedConfig });
    const bufferedMessage = makeMessage("1.300");

    await handler(bufferedMessage);
    await runOnFlush([queuedEntries()[0]!]);

    await handler(bufferedMessage);
    await runOnFlush([queuedEntries()[1]!]);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    flushKeyMock.mockClear();

    await handler(makeMessage("1.401", "file", { subtype: "file_share", files: [{ id: "F1" }] }));

    expect(flushKeyMock).not.toHaveBeenCalled();
  });

  it("carries durable ingress ownership into prepared dispatch", async () => {
    prepareMock.mockResolvedValueOnce({
      ctxPayload: {},
      route: { sessionKey: "agent:main:slack:channel:C111" },
    });
    const turnAdoptionLifecycle = { ...lifecycle(), onSessionRouted: vi.fn(async () => {}) };
    const handler = testHandler();
    const handled = handler(makeMessage("1.550"), {
      awaitDispatch: true,
      turnAdoptionLifecycle,
    });

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    expect(resolveThreadTsMock).toHaveBeenCalledWith({
      message: expect.objectContaining({ channel: "C111", ts: "1.550" }),
      source: "message",
      turnAdoptionLifecycle,
    });
    let settled = false;
    void handled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await runOnFlush();
    await expect(handled).resolves.toBeUndefined();

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
      const handler = testHandler();
      const twinTs = denied ? "1.1881" : "1.1778";
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

      await runOnFlush();

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
      const handler = testHandler();
      const messages = [
        { ts: "1.1779", text: "first message" },
        { ts: "1.1780", text: "second message" },
      ] as const;
      const handled = messages.map((message, index) =>
        handler(
          makeMessage(message.ts, message.text, {
            channel: authentication === "verified" ? "D111" : "D112",
          }),
          { source: "message", senderAuthentication: index === 0 ? authentication : "verified" },
        ),
      );
      await expect(Promise.all(handled)).resolves.toEqual([undefined, undefined]);
      expect(enqueueMock).toHaveBeenCalledTimes(2);

      await runOnFlush();

      expectPrepared(
        { text: "first message\nsecond message" },
        { senderAuthentication: authentication },
      );
      expect(dispatchMock).toHaveBeenCalledOnce();
      expect(dispatchMock.mock.calls[0]![0].ctxPayload).toMatchObject({
        MessageSids: [messages[0].ts, messages[1].ts],
        MessageSidFirst: messages[0].ts,
        MessageSidLast: messages[1].ts,
      });
    },
  );

  it("releases every acquired claim when cancellation interrupts the next claim", async () => {
    const controller = new AbortController();
    const pending = createDeferred<{ kind: "claimed"; handle: ReturnType<typeof makeClaim> }>();
    const first = makeClaim("first");
    const second = makeClaim("second");
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
    vi.spyOn(dedupe, "createSlackMessageDispatchReplayGuard").mockReturnValueOnce(guard);
    const handler = testHandler({ abortSignal: controller.signal });
    for (const ts of ["1.4001", "1.4002"]) {
      await handler(makeMessage(ts));
    }
    expect(queuedEntries()).toHaveLength(2);
    const flushing = runOnFlush();
    const rejected = expect(flushing).rejects.toThrow("cancelled during claim");
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    controller.abort(new Error("cancelled during claim"));
    pending.resolve({ kind: "claimed", handle: second });
    await rejected;
    for (const handle of [first, second]) {
      expect(handle.release).toHaveBeenCalledOnce();
    }
    expectUncalled(first.commit, second.commit, prepareMock, dispatchMock);
  });

  it("defers ingress before waiting for a duplicate's dispatch claim", async () => {
    const duplicate = createDeferred<boolean>();
    const onDispatchWaiting = vi.fn();
    mockReplayGuard({
      claim: async () => ({ kind: "inflight", pending: duplicate.promise }),
    });
    const handler = testHandler({ ctx: createContext() });
    const handled = handler(makeMessage("1.9999"), {
      awaitDispatch: true,
      turnAdoptionLifecycle: { ...lifecycle(), onDispatchWaiting },
    });
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
    const admission = debouncer.enqueue(queuedEntries()[0]!);
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
    mockReplayGuard({ claim });
    const handler = testHandler();
    for (const ts of ["1.701", "1.702"]) {
      await handler(makeMessage(ts, "retry me"));
    }
    const flushing = runOnFlush();
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
      expect(queuedEntries().slice(2)).toMatchObject([
        { retry: { attempt: 1 } },
        { retry: { attempt: 1 } },
      ]);
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
    const handler = testHandler({ ctx });
    const invalid: OpenClawConfig = {
      channels: { slack: { dmPolicy: "allowlist", allowFrom: ["@invalid-name"] } },
    };
    setRuntimeConfigSnapshot(invalid, invalid);
    const message = makeMessage("300.001", "hello", {
      channel: "D12345678",
      channel_type: "im" as const,
      user: "U12345678",
    });
    await expect(handler(message, { awaitDispatch: true })).rejects.toThrow("stable Slack IDs");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expectUncalled(prepareMock, dispatchMock);

    setRuntimeConfigSnapshot(cfg, cfg);
    await handler({ ...message, ts: "300.002" }, { awaitDispatch: true });
    expect(prepareMock).toHaveBeenCalledOnce();
    expect(dispatchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [
      makeMessage("1.200", "hello", { channel: "C123", user: "U456", parent_user_id: "U789" }),
      "slack:default:C123:maybe-thread:1.200:U456",
    ],
    [
      { type: "message", channel: "C123", user: "U456", text: "hello" } satisfies SlackMessageEvent,
      "slack:default:C123:U456",
    ],
  ] as const)("isolates debounce key %s", (message, key) => {
    expect(buildSlackDebounceKey(message, "default")).toBe(key);
  });
});
