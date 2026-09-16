import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixClient } from "../sdk.js";
import { createMatrixDraftController } from "./handler-draft-controller.js";
import { createMatrixReplyDispatcher } from "./handler-reply-dispatcher.js";
import { createTypingCallbacks } from "./runtime-api.js";

const deliveryMocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  edit: vi.fn(async () => "$edited"),
  sendDraft: vi.fn(async () => ({ messageId: "$draft", roomId: "!room:example.org" })),
}));

vi.mock("./replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./replies.js")>()),
  deliverMatrixReplies: deliveryMocks.deliver,
}));

vi.mock("../send.js", () => ({
  editMessageMatrix: deliveryMocks.edit,
  prepareMatrixSingleText: (text: string) => ({
    trimmedText: text.trim(),
    convertedText: text.trim(),
    singleEventLimit: 4000,
    fitsInSingleEvent: true,
  }),
  resolveMatrixMentionsForBody: async () => ({}),
  sendSingleTextMessageMatrix: deliveryMocks.sendDraft,
}));

describe("Matrix reasoning delivery failures", () => {
  beforeEach(() => {
    installMatrixMonitorTestRuntime();
    vi.clearAllMocks();
  });

  it.each([false, true])(
    "preserves the answer draft after a failed reasoning block (partial delivery: %s)",
    async (partialDelivery) => {
      const context = {
        cfg: {},
        client: {} as MatrixClient,
        roomId: "!room:example.org",
        accountId: "default",
        streaming: "partial" as const,
        replyToMode: "first" as const,
        logVerboseMessage: vi.fn(),
      };
      const controller = await createMatrixDraftController({
        ...context,
        messageId: "$inbound",
        previewToolProgressEnabled: false,
      });
      const draft = controller.draftStream!;
      const typingCallbacks = createTypingCallbacks({
        start: async () => {},
        onStartError: vi.fn(),
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const failedSend = new Error("reasoning send failed");
      const failure = partialDelivery
        ? createChannelPartialDeliveryError(failedSend, {
            messageIds: ["$reasoning-chunk"],
            visibleReplySent: true,
          })
        : failedSend;
      deliveryMocks.deliver.mockRejectedValueOnce(failure);
      const matrix = createMatrixReplyDispatcher({
        ...context,
        draftStream: draft,
        draftController: controller,
        prefixOptions: {},
        humanDelay: undefined,
        typingCallbacks,
        runtime,
        mediaLocalRoots: [],
        shouldDeliverReasoning: () => true,
      });
      const onError = vi.fn(matrix.onReplyError);
      const dispatcher = createReplyDispatcher({ deliver: matrix.deliverReply, onError });
      try {
        controller.onPartialReply("Answer prefix");
        await draft.flush();
        dispatcher.sendBlockReply({ text: "Check the inputs", isReasoning: true });
        const failed = await dispatcher.waitForIdle();

        expect(failed).toMatchObject({
          counts: { block: { delivered: 0, failedAfterSend: 1 } },
        });
        expect(matrix.nonFinalReplyDeliveryFailed()).toBe(true);
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure, { kind: "block" });
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("reply failed"));

        const answer = "Answer prefix with the complete result";
        controller.onPartialReply(answer);
        await draft.flush();
        expect(deliveryMocks.sendDraft).toHaveBeenCalledTimes(1);
        expect(deliveryMocks.edit).toHaveBeenLastCalledWith(
          context.roomId,
          "$draft",
          answer,
          expect.objectContaining({ live: true }),
        );

        dispatcher.sendFinalReply({ text: answer, replyToId: "$inbound" });
        dispatcher.markComplete();
        const settled = await dispatcher.waitForIdle();
        expect(settled).toMatchObject({ counts: { final: { delivered: 1 } } });
        expect(deliveryMocks.edit).toHaveBeenLastCalledWith(
          context.roomId,
          "$draft",
          answer,
          expect.objectContaining({ live: false }),
        );
        expect(deliveryMocks.deliver).toHaveBeenCalledTimes(1);
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        await draft.discardPending();
        controller.cancelProgressDraft();
        typingCallbacks.onCleanup?.();
      }
    },
  );
});
