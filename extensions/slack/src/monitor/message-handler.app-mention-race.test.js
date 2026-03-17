import { beforeEach, describe, expect, it, vi } from "vitest";
const prepareSlackMessageMock = vi.fn();
const dispatchPreparedSlackMessageMock = vi.fn();
vi.mock("../../../../src/channels/inbound-debounce-policy.js", () => ({
  shouldDebounceTextInbound: () => false,
  createChannelInboundDebouncer: (params) => ({
    debounceMs: 0,
    debouncer: {
      enqueue: async (entry) => {
        await params.onFlush([entry]);
      },
      flushKey: async (_key) => {
      }
    }
  })
}));
vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: async ({ message }) => message
  })
}));
vi.mock("./message-handler/prepare.js", () => ({
  prepareSlackMessage: (params) => prepareSlackMessageMock(params)
}));
vi.mock("./message-handler/dispatch.js", () => ({
  dispatchPreparedSlackMessage: (prepared) => dispatchPreparedSlackMessageMock(prepared)
}));
import { createSlackMessageHandler } from "./message-handler.js";
function createMarkMessageSeen() {
  const seen = /* @__PURE__ */ new Set();
  return (channel, ts) => {
    if (!channel || !ts) {
      return false;
    }
    const key = `${channel}:${ts}`;
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
    return false;
  };
}
function createTestHandler() {
  return createSlackMessageHandler({
    ctx: {
      cfg: {},
      accountId: "default",
      app: { client: {} },
      runtime: {},
      markMessageSeen: createMarkMessageSeen()
    },
    account: { accountId: "default" }
  });
}
function createSlackEvent(params) {
  return { type: params.type, channel: "C1", ts: params.ts, text: params.text };
}
async function sendMessageEvent(handler, ts) {
  await handler(createSlackEvent({ type: "message", ts, text: "hello" }), { source: "message" });
}
async function sendMentionEvent(handler, ts) {
  await handler(createSlackEvent({ type: "app_mention", ts, text: "<@U_BOT> hello" }), {
    source: "app_mention",
    wasMentioned: true
  });
}
async function createInFlightMessageScenario(ts) {
  let resolveMessagePrepare;
  const messagePrepare = new Promise((resolve) => {
    resolveMessagePrepare = resolve;
  });
  prepareSlackMessageMock.mockImplementation(async ({ opts }) => {
    if (opts.source === "message") {
      return messagePrepare;
    }
    return { ctxPayload: {} };
  });
  const handler = createTestHandler();
  const messagePending = handler(createSlackEvent({ type: "message", ts, text: "hello" }), {
    source: "message"
  });
  await Promise.resolve();
  return { handler, messagePending, resolveMessagePrepare };
}
describe("createSlackMessageHandler app_mention race handling", () => {
  beforeEach(() => {
    prepareSlackMessageMock.mockReset();
    dispatchPreparedSlackMessageMock.mockReset();
  });
  it("allows a single app_mention retry when message event was dropped before dispatch", async () => {
    prepareSlackMessageMock.mockImplementation(async ({ opts }) => {
      if (opts.source === "message") {
        return null;
      }
      return { ctxPayload: {} };
    });
    const handler = createTestHandler();
    await sendMessageEvent(handler, "1700000000.000100");
    await sendMentionEvent(handler, "1700000000.000100");
    await sendMentionEvent(handler, "1700000000.000100");
    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });
  it("allows app_mention while message handling is still in-flight, then keeps later duplicates deduped", async () => {
    const { handler, messagePending, resolveMessagePrepare } = await createInFlightMessageScenario("1700000000.000150");
    await sendMentionEvent(handler, "1700000000.000150");
    resolveMessagePrepare?.(null);
    await messagePending;
    await sendMentionEvent(handler, "1700000000.000150");
    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });
  it("suppresses message dispatch when app_mention already dispatched during in-flight race", async () => {
    const { handler, messagePending, resolveMessagePrepare } = await createInFlightMessageScenario("1700000000.000175");
    await sendMentionEvent(handler, "1700000000.000175");
    resolveMessagePrepare?.({ ctxPayload: {} });
    await messagePending;
    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });
  it("keeps app_mention deduped when message event already dispatched", async () => {
    prepareSlackMessageMock.mockResolvedValue({ ctxPayload: {} });
    const handler = createTestHandler();
    await sendMessageEvent(handler, "1700000000.000200");
    await sendMentionEvent(handler, "1700000000.000200");
    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });
});
