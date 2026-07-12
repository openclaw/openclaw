// Discord draft preview controller tests cover the cleanup retry lifecycle.
import { describe, expect, it, vi } from "vitest";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";

describe("createDiscordDraftPreviewController", () => {
  describe("cleanup", () => {
    it("retries preview clear during teardown when the first clear after final delivery failed", async () => {
      const messages: string[] = [];
      let messageId: string | undefined = "preview-1";
      const clearCalls: string[] = [];

      const controller = createDiscordDraftPreviewController({
        cfg: { plugins: { entries: {} } },
        discordConfig: {},
        accountId: "acct-1",
        sourceRepliesAreToolOnly: false,
        textLimit: 2000,
        deliveryRest: {
          post: vi.fn(async () => ({ id: "preview-1" })),
          patch: vi.fn(async () => undefined),
          delete: vi.fn(async () => {
            clearCalls.push(`delete:${messageId}`);
            if (clearCalls.length === 1) {
              throw new Error("boom");
            }
            messageId = undefined;
          }),
        },
        deliverChannelId: "ch-1",
        replyReference: { peek: () => undefined },
        tableMode: "keep",
        maxLinesPerMessage: undefined,
        chunkMode: "none",
        log: (msg: string) => {
          messages.push(msg);
        },
      });

      // Stream a few messages to create a preview
      controller.updateFromPartial("hello world");
      await controller.flush();

      expect(controller.draftStream?.messageId()).toBe("preview-1");

      // Simulate: final reply starts, is delivered, and the preview clear fails
      controller.markFinalReplyStarted();
      controller.markFinalReplyDelivered();

      // First clear during delivery: DELETE fails, ID retained
      await controller.draftStream?.clear();
      expect(clearCalls).toEqual(["delete:preview-1"]);
      // ID survives the failed DELETE (proves compare-and-clear in shared helper)
      expect(controller.draftStream?.messageId()).toBe("preview-1");

      // Simulate teardown: cleanup() retries the clear
      await controller.cleanup();

      // The retry in cleanup() should have called delete again and succeeded
      expect(clearCalls).toEqual(["delete:preview-1", "delete:preview-1"]);
      // After successful retry, the ID is cleared
      expect(controller.draftStream?.messageId()).toBeUndefined();
    });

    it("skips the retry when the preview was finalized in place", async () => {
      const clearCalls: string[] = [];

      const controller = createDiscordDraftPreviewController({
        cfg: { plugins: { entries: {} } },
        discordConfig: {},
        accountId: "acct-2",
        sourceRepliesAreToolOnly: false,
        textLimit: 2000,
        deliveryRest: {
          post: vi.fn(async () => ({ id: "preview-2" })),
          patch: vi.fn(async () => undefined),
          delete: vi.fn(async () => {
            clearCalls.push("delete");
          }),
        },
        deliverChannelId: "ch-2",
        replyReference: { peek: () => undefined },
        tableMode: "keep",
        maxLinesPerMessage: undefined,
        chunkMode: "none",
        log: () => {},
      });

      controller.updateFromPartial("hello");
      await controller.flush();

      // Simulate: preview is finalized in place (edited, not replaced)
      controller.markFinalReplyStarted();
      controller.markPreviewFinalized();
      controller.markFinalReplyDelivered();

      // Clear the preview (succeeds)
      await controller.draftStream?.clear();

      // Teardown: retry should NOT fire because finalizedViaPreviewMessage is true
      await controller.cleanup();

      // Only one clear attempt — no retry needed
      expect(clearCalls).toEqual(["delete"]);
    });
  });
});
