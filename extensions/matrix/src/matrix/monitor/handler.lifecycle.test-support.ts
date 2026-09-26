import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, type Mock, vi } from "vitest";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

type ReplyOpts = GetReplyOptions;
type LifecycleHarness = {
  sendSingleTextMessageMatrixMock: Mock;
  editMessageMatrixMock: Mock;
  deliverMatrixRepliesMock: Mock;
  waitForMatrixState: (assertion: () => void | Promise<void>) => Promise<void>;
  createMockMatrixDeliveryResult: () => unknown;
  expectEditLiveFlag: (eventId: string, text: string, expected: boolean | undefined) => void;
};

export function registerMatrixLifecycleTests({
  sendSingleTextMessageMatrixMock,
  editMessageMatrixMock,
  deliverMatrixRepliesMock,
  waitForMatrixState,
  createMockMatrixDeliveryResult,
  expectEditLiveFlag,
}: LifecycleHarness) {
  const dispatcher = () => ({
    dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
    replyOptions: {},
    markDispatchIdle: () => {},
    markRunComplete: () => {},
  });
  it("retains a quiet draft accepted before the handler throws", async () => {
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());
    const redactEventMock = vi.fn(async () => "$redacted");
    let releaseFailure: (() => void) | undefined;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const { handler } = createMatrixHandlerTestHarness({
      streaming: "quiet",
      client: { redactEvent: redactEventMock },
      createReplyDispatcherWithTyping: dispatcher,
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
        await args.replyOptions?.onPartialReply?.({ text: "visible before failure" });
        await failureGate;
        throw new Error("model timeout");
      }) as never,
    });
    const handlerPromise = handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );
    await waitForMatrixState(() =>
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1),
    );
    releaseFailure?.();
    await handlerPromise;
    expect(redactEventMock).not.toHaveBeenCalled();
  });

  it("finalizes and retains visible live drafts when generation aborts mid-stream", async () => {
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());
    const redactEventMock = vi.fn(async () => "$redacted");
    let capturedReplyOpts: GetReplyOptions | undefined;
    const { handler } = createMatrixHandlerTestHarness({
      streaming: "partial",
      client: { redactEvent: redactEventMock },
      createReplyDispatcherWithTyping: dispatcher,
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: GetReplyOptions }) => {
        capturedReplyOpts = args.replyOptions;
        await capturedReplyOpts?.onPartialReply?.({ text: "partial" });
        await waitForMatrixState(() =>
          expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1),
        );
        throw new Error("model timeout");
      }) as never,
    });
    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );
    expectEditLiveFlag("$draft1", "partial", false);
    expect(redactEventMock).not.toHaveBeenCalled();
  });

  it("redacts partial live drafts when abort finalization fails", async () => {
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockRejectedValueOnce(new Error("finalize failed"));
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());
    const redactEventMock = vi.fn(async () => "$redacted");
    const { handler } = createMatrixHandlerTestHarness({
      streaming: "partial",
      client: { redactEvent: redactEventMock },
      createReplyDispatcherWithTyping: dispatcher,
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
        await args.replyOptions?.onPartialReply?.({ text: "partial" });
        await waitForMatrixState(() =>
          expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1),
        );
        throw new Error("model timeout");
      }) as never,
    });
    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );
    expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
  });

  it("finalizes a receipt-cancelled draft even when legacy counters report a final", async () => {
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
    const redactEventMock = vi.fn(async () => "$redacted");
    const emptyCounts = {
      delivered: 0,
      deliveredNotVisible: 0,
      cancelled: 0,
      failedBeforeSend: 0,
      failedAfterSend: 0,
    };
    const { handler } = createMatrixHandlerTestHarness({
      streaming: "partial",
      client: { redactEvent: redactEventMock },
      createReplyDispatcherWithTyping: dispatcher,
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
        await args.replyOptions?.onPartialReply?.({ text: "partial" });
        await waitForMatrixState(() =>
          expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1),
        );
        return {
          queuedFinal: true,
          counts: { final: 1, block: 0, tool: 0 },
          settledReceipt: {
            anyVisibleDelivered: false,
            counts: {
              tool: { ...emptyCounts },
              block: { ...emptyCounts },
              final: { ...emptyCounts, cancelled: 1 },
            },
          },
        };
      }) as never,
    });
    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );
    expectEditLiveFlag("$draft1", "partial", false);
    expect(redactEventMock).not.toHaveBeenCalled();
  });

  it("redacts an accepted partial when dispatch deliberately ends silently", async () => {
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
    const redactEventMock = vi.fn(async () => "$redacted");
    const { handler } = createMatrixHandlerTestHarness({
      streaming: "partial",
      client: { redactEvent: redactEventMock },
      createReplyDispatcherWithTyping: dispatcher,
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
        await args.replyOptions?.onPartialReply?.({ text: "partial" });
        await waitForMatrixState(() =>
          expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1),
        );
        return {
          queuedFinal: false,
          counts: { final: 0, block: 0, tool: 0 },
          deliberateSilentTerminalReply: true,
        };
      }) as never,
    });
    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
  });
}
