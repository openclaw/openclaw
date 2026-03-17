import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackMessageHandler } from "./message-handler.js";
const enqueueMock = vi.fn(async (_entry) => {
});
const flushKeyMock = vi.fn(async (_key) => {
});
const resolveThreadTsMock = vi.fn(async ({ message }) => ({
  ...message
}));
vi.mock("../../../../src/auto-reply/inbound-debounce.js", () => ({
  resolveInboundDebounceMs: () => 10,
  createInboundDebouncer: () => ({
    enqueue: (entry) => enqueueMock(entry),
    flushKey: (key) => flushKeyMock(key)
  })
}));
vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: (entry) => resolveThreadTsMock(entry)
  })
}));
function createContext(overrides) {
  return {
    cfg: {},
    accountId: "default",
    app: {
      client: {}
    },
    runtime: {},
    markMessageSeen: (channel, ts) => overrides?.markMessageSeen?.(channel, ts) ?? false
  };
}
function createHandlerWithTracker(overrides) {
  const trackEvent = vi.fn();
  const handler = createSlackMessageHandler({
    ctx: createContext(overrides),
    account: { accountId: "default" },
    trackEvent
  });
  return { handler, trackEvent };
}
async function handleDirectMessage(handler) {
  await handler(
    {
      type: "message",
      channel: "D1",
      ts: "123.456",
      text: "hello"
    },
    { source: "message" }
  );
}
describe("createSlackMessageHandler", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
    flushKeyMock.mockClear();
    resolveThreadTsMock.mockClear();
  });
  it("does not track invalid non-message events from the message stream", async () => {
    const trackEvent = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" },
      trackEvent
    });
    await handler(
      {
        type: "reaction_added",
        channel: "D1",
        ts: "123.456"
      },
      { source: "message" }
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
      account: { accountId: "default" }
    });
    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000100",
        text: "first buffered text"
      },
      { source: "message" }
    );
    await handler(
      {
        type: "message",
        subtype: "file_share",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000200",
        text: "file follows",
        files: [{ id: "F1" }]
      },
      { source: "message" }
    );
    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
  });
});
