import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackMessageHandler } from "./message-handler.js";

const enqueueMock = vi.fn(async (_entry: unknown) => {});
const flushKeyMock = vi.fn(async (_key: string) => {});
const resolveThreadTsMock = vi.fn(async ({ message }: { message: Record<string, unknown> }) => ({
  ...message,
}));
const logVerboseMock = vi.fn((_msg: string) => {});
const shouldLogVerboseMock = vi.fn(() => false);

vi.mock("../../../../src/auto-reply/inbound-debounce.js", () => ({
  resolveInboundDebounceMs: () => 10,
  createInboundDebouncer: () => ({
    enqueue: (entry: unknown) => enqueueMock(entry),
    flushKey: (key: string) => flushKeyMock(key),
  }),
}));

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: (entry: { message: Record<string, unknown> }) => resolveThreadTsMock(entry),
  }),
}));

vi.mock("../../../../src/globals.js", () => ({
  logVerbose: (msg: string) => logVerboseMock(msg),
  shouldLogVerbose: () => shouldLogVerboseMock(),
  danger: (msg: string) => msg,
}));

function createContext(overrides?: {
  markMessageSeen?: (channel: string | undefined, ts: string | undefined) => boolean;
}) {
  return {
    cfg: {},
    accountId: "default",
    app: {
      client: {},
    },
    runtime: {},
    markMessageSeen: (channel: string | undefined, ts: string | undefined) =>
      overrides?.markMessageSeen?.(channel, ts) ?? false,
  } as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
}

function createHandlerWithTracker(overrides?: {
  markMessageSeen?: (channel: string | undefined, ts: string | undefined) => boolean;
}) {
  const trackEvent = vi.fn();
  const handler = createSlackMessageHandler({
    ctx: createContext(overrides),
    account: { accountId: "default" } as Parameters<typeof createSlackMessageHandler>[0]["account"],
    trackEvent,
  });
  return { handler, trackEvent };
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
    enqueueMock.mockClear();
    flushKeyMock.mockClear();
    resolveThreadTsMock.mockClear();
    logVerboseMock.mockClear();
    shouldLogVerboseMock.mockReset().mockReturnValue(false);
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

  it("does not track duplicate messages that are already seen", async () => {
    const { handler, trackEvent } = createHandlerWithTracker({ markMessageSeen: () => true });

    await handleDirectMessage(handler);

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("tracks accepted non-duplicate messages", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handleDirectMessage(handler);

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("flushes pending top-level buffered keys before immediate non-debounce follow-ups", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext(),
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

  it("logs DM trace when verbose mode is enabled", async () => {
    shouldLogVerboseMock.mockReturnValue(true);
    const { handler } = createHandlerWithTracker();

    await handleDirectMessage(handler);

    const dmTraceCall = logVerboseMock.mock.calls.find((c) =>
      c[0].includes("slack inbound DM: channel=D1"),
    );
    expect(dmTraceCall).toBeDefined();
    expect(dmTraceCall?.[0]).toContain("ts=123.456");
    expect(dmTraceCall?.[0]).toContain("source=message");
  });

  it("logs dedup drop when verbose mode is enabled and message is already seen", async () => {
    shouldLogVerboseMock.mockReturnValue(true);
    const { handler } = createHandlerWithTracker({ markMessageSeen: () => true });

    await handleDirectMessage(handler);

    const dedupCall = logVerboseMock.mock.calls.find((c) =>
      c[0].includes("slack inbound: dedup drop"),
    );
    expect(dedupCall).toBeDefined();
    expect(dedupCall?.[0]).toContain("channel=D1");
    expect(dedupCall?.[0]).toContain("ts=123.456");
    expect(dedupCall?.[0]).toContain("source=message");
  });

  it("does not log DM trace when verbose mode is disabled", async () => {
    shouldLogVerboseMock.mockReturnValue(false);
    const { handler } = createHandlerWithTracker();

    await handleDirectMessage(handler);

    const dmTraceCall = logVerboseMock.mock.calls.find((c) => c[0].includes("slack inbound DM:"));
    expect(dmTraceCall).toBeUndefined();
  });
});
