import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
const recordInboundSessionMock = vi.fn().mockResolvedValue(void 0);
vi.mock("../../../src/channels/session.js", () => ({
  recordInboundSession: (...args) => recordInboundSessionMock(...args)
}));
describe("buildTelegramMessageContext DM topic threadId in deliveryContext (#8891)", () => {
  async function buildCtx(params) {
    return await buildTelegramMessageContextForTest({
      message: params.message,
      options: params.options,
      resolveGroupActivation: params.resolveGroupActivation
    });
  }
  function getUpdateLastRoute() {
    const callArgs = recordInboundSessionMock.mock.calls[0]?.[0];
    return callArgs?.updateLastRoute;
  }
  beforeEach(() => {
    recordInboundSessionMock.mockClear();
  });
  it("passes threadId to updateLastRoute for DM topics", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        message_thread_id: 42
        // DM Topic ID
      }
    });
    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();
    const updateLastRoute = getUpdateLastRoute();
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.to).toBe("telegram:1234");
    expect(updateLastRoute?.threadId).toBe("42");
  });
  it("does not pass threadId for regular DM without topic", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" }
      }
    });
    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();
    const updateLastRoute = getUpdateLastRoute();
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.to).toBe("telegram:1234");
    expect(updateLastRoute?.threadId).toBeUndefined();
  });
  it("does not set updateLastRoute for group messages", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        text: "@bot hello",
        message_thread_id: 99
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true
    });
    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();
    expect(getUpdateLastRoute()).toBeUndefined();
  });
});
