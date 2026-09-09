// Slack tests cover message handler plugin behavior.
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
      ingressObserver?: unknown;
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
    account: { accountId: "default" } as Parameters<typeof createSlackMessageHandler>[0]["account"],
    trackEvent,
  });
  return { handler, trackEvent, ctx };
}

async function handleDirectMessage(
  handler: ReturnType<typeof createHandlerWithTracker>["handler"],
) {
  await handler(
    {
      type: "message",
      channel: "D1",
      ts: "123.456",
      text: "hello",
    } as never,
    { source: "message" },
  );
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

  it("uses the latest runtime config for messages without restarting the monitor", async () => {
    const startupConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "max" } } };
    const updatedConfig: OpenClawConfig = {
      agents: { defaults: { thinkingDefault: "ultra", fastModeDefault: true } },
    };
    setRuntimeConfigSnapshot(startupConfig, startupConfig);
    const context = createContext({ cfg: startupConfig });
    const handler = createSlackMessageHandler({
      ctx: context,
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    setRuntimeConfigSnapshot(updatedConfig, updatedConfig);
    await handler(
      {
        type: "message",
        channel: "D1",
        user: "U1",
        ts: "1709000000.009001",
        text: "hello",
      } as never,
      { source: "message" },
    );
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await runOnFlush([entry]);

    expect(prepareSlackMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ cfg: updatedConfig }),
      }),
    );
    expect(context.cfg).toBe(startupConfig);
  });

  it("keeps cached runtime contexts synchronized with mutable monitor state", async () => {
    const startupConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "max" } } };
    const runtimeConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "ultra" } } };
    const initialChannels = { C_OLD: { enabled: true } };
    const resolvedChannels = { C_RESOLVED: { enabled: true } };
    setRuntimeConfigSnapshot(startupConfig, startupConfig);
    const context = createContext({ cfg: startupConfig });
    context.botUserId = "U_STALE";
    context.channelsConfig = initialChannels;
    const handler = createSlackMessageHandler({
      ctx: context,
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });
    setRuntimeConfigSnapshot(runtimeConfig, runtimeConfig);

    const handleMessage = async (ts: string) => {
      await handler(
        {
          type: "message",
          channel: "D1",
          user: "U1",
          ts,
          text: "hello",
        } as never,
        { source: "message" },
      );
      const entry = enqueueMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      await runOnFlush([entry]);
    };

    await handleMessage("1709000000.009007");
    const initialRuntimeContext = prepareSlackMessageMock.mock.calls[0]?.[0]?.ctx;
    expect(initialRuntimeContext).toMatchObject({
      cfg: runtimeConfig,
      botUserId: "U_STALE",
      channelsConfig: initialChannels,
    });

    context.botUserId = "U_RECOVERED";
    context.channelsConfig = resolvedChannels;
    await handleMessage("1709000000.009008");

    const reusedRuntimeContext = prepareSlackMessageMock.mock.calls[1]?.[0]?.ctx;
    expect(reusedRuntimeContext).toBe(initialRuntimeContext);
    expect(reusedRuntimeContext).toMatchObject({
      cfg: runtimeConfig,
      botUserId: "U_RECOVERED",
      channelsConfig: resolvedChannels,
    });
    expect(context.cfg).toBe(startupConfig);
  });

  it.each([
    {
      label: "without a source snapshot",
      includeSourceSnapshot: false,
      messageTs: "1709000000.009004",
    },
    {
      label: "with an unrelated source snapshot",
      includeSourceSnapshot: true,
      messageTs: "1709000000.009005",
    },
  ])("preserves explicit monitor config $label", async ({ includeSourceSnapshot, messageTs }) => {
    const explicitConfig: OpenClawConfig = {
      agents: { defaults: { thinkingDefault: "ultra" } },
      messages: { responsePrefix: "scoped" },
    };
    const unrelatedRuntimeConfig: OpenClawConfig = {
      agents: { defaults: { thinkingDefault: "low" } },
    };
    setRuntimeConfigSnapshot(
      unrelatedRuntimeConfig,
      includeSourceSnapshot ? unrelatedRuntimeConfig : undefined,
    );
    const context = createContext({ cfg: explicitConfig });
    const handler = createSlackMessageHandler({
      ctx: context,
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    setRuntimeConfigSnapshot({ agents: { defaults: { thinkingDefault: "high" } } });
    await handler(
      {
        type: "message",
        channel: "D1",
        user: "U1",
        ts: messageTs,
        text: "hello",
      } as never,
      { source: "message" },
    );
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await runOnFlush([entry]);

    expect(prepareSlackMessageMock).toHaveBeenCalledWith(expect.objectContaining({ ctx: context }));
    expect(context.cfg).toBe(explicitConfig);
  });

  it("follows runtime updates when the monitor config matches the runtime source", async () => {
    const startupSourceConfig: OpenClawConfig = {
      agents: { defaults: { thinkingDefault: "max" } },
    };
    const startupRuntimeConfig: OpenClawConfig = {
      agents: { defaults: { thinkingDefault: "max", fastModeDefault: false } },
    };
    const updatedRuntimeConfig: OpenClawConfig = {
      agents: { defaults: { thinkingDefault: "ultra", fastModeDefault: true } },
    };
    setRuntimeConfigSnapshot(startupRuntimeConfig, startupSourceConfig);
    const context = createContext({ cfg: structuredClone(startupSourceConfig) });
    const handler = createSlackMessageHandler({
      ctx: context,
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    setRuntimeConfigSnapshot(updatedRuntimeConfig, updatedRuntimeConfig);
    await handler(
      {
        type: "message",
        channel: "D1",
        user: "U1",
        ts: "1709000000.009006",
        text: "hello",
      } as never,
      { source: "message" },
    );
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await runOnFlush([entry]);

    expect(prepareSlackMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ cfg: updatedRuntimeConfig }),
      }),
    );
    expect(context.cfg).toEqual(startupSourceConfig);
  });

  it("keeps each in-flight message on its captured config snapshot", async () => {
    const startupConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "max" } } };
    const firstConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "high" } } };
    const secondConfig: OpenClawConfig = { agents: { defaults: { thinkingDefault: "ultra" } } };
    setRuntimeConfigSnapshot(startupConfig, startupConfig);
    const context = createContext({ cfg: startupConfig });
    const handler = createSlackMessageHandler({
      ctx: context,
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
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
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
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

  it("tracks accepted messages", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handleDirectMessage(handler);

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock.mock.calls[0]?.[0]).not.toHaveProperty("turnAdoptionLifecycle");
    expect(enqueueMock).toHaveBeenCalledTimes(1);
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

  it("accepts thread_broadcast messages from the message stream", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handler(
      {
        type: "message",
        subtype: "thread_broadcast",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000300",
        text: "also send to channel",
        thread_ts: "1709000000.000100",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
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

  it("flushes pending top-level buffered keys before immediate non-debounce follow-ups", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext({ cfg: { messages: { inbound: { debounceMs: 10 } } } }),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
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
        subtype: "file_share",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000200",
        text: "file follows",
        files: [{ id: "F1" }],
      } as never,
      { source: "message" },
    );

    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
  });

  it("flushes buffered text before a table-bearing message", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext({ cfg: { messages: { inbound: { debounceMs: 10 } } } }),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
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
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
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

  it("waits for debounced dispatch completion when requested by relay delivery", async () => {
    const { handler } = createHandlerWithTracker();
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000500",
        text: "relay message",
      } as never,
      { source: "message", awaitDispatch: true },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    let settled = false;
    void handled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await runOnFlush([entry]);
    await expect(handled).resolves.toBeUndefined();
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });
});
