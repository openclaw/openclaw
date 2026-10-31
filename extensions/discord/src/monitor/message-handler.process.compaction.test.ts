import { createReplyDispatcher, type ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import {
  createNoQueuedDispatchResult,
  deliverDiscordReply,
  dispatchBufferedReplyForTest,
  dispatchInboundMessageForTest,
  registerDiscordProcessTestLifecycle,
  runProcessDiscordMessage,
} from "./message-handler.process.test-harness.js";
import { createAutomaticDraftContext } from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

const notices: [ReplyPayload, ReplyPayload] = [
  { text: "🧹 Compacting context...", isCompactionNotice: true },
  { text: "🧹 Compaction complete", isCompactionNotice: true },
];

// Keep the process harness's external delivery fixture, but exercise the real
// dispatcher normalization and before-delivery cancellation rather than its shim.
function useRealDispatcher() {
  dispatchBufferedReplyForTest.mockImplementationOnce(async (params) => {
    const dispatcher = createReplyDispatcher(params.dispatcherOptions);
    try {
      return await dispatchInboundMessageForTest({
        ctx: params.ctx,
        replyOptions: params.replyOptions,
        dispatcher: {
          ...dispatcher,
          waitForIdle: async () => {
            await dispatcher.waitForIdle();
          },
        },
      });
    } finally {
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
  });
}

describe("Discord progress compaction notice delivery", () => {
  it("delivers start and completion blocks without exposing ordinary answer blocks", async () => {
    useRealDispatcher();
    dispatchInboundMessageForTest.mockImplementationOnce(async (params) => {
      expect(params).toBeDefined();
      await params!.dispatcher.sendBlockReply({ text: "ordinary answer delta" });
      for (const notice of notices) {
        await params!.dispatcher.sendBlockReply(notice);
      }
      return createNoQueuedDispatchResult();
    });

    await runProcessDiscordMessage(
      await createAutomaticDraftContext({ discordConfig: { streaming: { mode: "progress" } } }),
    );

    expect(deliverDiscordReply.mock.calls.map(([params]) => params)).toEqual(
      notices.map((notice) => expect.objectContaining({ kind: "block", replies: [notice] })),
    );
  });

  it("does not deliver a notice after cancellation of the admitted turn", async () => {
    const abort = new AbortController();
    useRealDispatcher();
    dispatchInboundMessageForTest.mockImplementationOnce(async (params) => {
      abort.abort();
      await params!.dispatcher.sendBlockReply(notices[0]);
      return createNoQueuedDispatchResult();
    });

    await runProcessDiscordMessage(
      await createAutomaticDraftContext({
        abortSignal: abort.signal,
        discordConfig: { streaming: { mode: "progress" } },
      }),
    );

    expect(dispatchInboundMessageForTest).toHaveBeenCalledOnce();
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("does not admit notices when the source send policy is no longer current", async () => {
    await runProcessDiscordMessage(
      await createAutomaticDraftContext({
        isPolicyCurrent: () => false,
        discordConfig: { streaming: { mode: "progress" } },
      }),
    );

    expect(dispatchInboundMessageForTest).not.toHaveBeenCalled();
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });
});
