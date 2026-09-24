import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { describe, expect, it } from "vitest";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import { createHarness, expectPreviewFinalized } from "./lane-delivery.test-support.js";

describe("createLaneTextDeliverer preceding input answers", () => {
  it("createLaneTextDeliverer preserves a preceding input answer when later text extends it", async () => {
    const earlierAnswer =
      "Here is the earlier answer with enough stable prefix text before the ellipsis...";
    const latestAnswer =
      "Here is the earlier answer with enough stable prefix text before the ellipsis and a much longer answer to the next question.";
    const answer = createTestDraftStream({ messageId: 999 });
    answer.update(latestAnswer);
    const harness = createHarness({
      answerStream: answer,
      resolveFinalPayloadCandidate: ({ payload }) => ({ ...payload, text: latestAnswer }),
    });
    harness.lanes.answer.hasStreamedMessage = true;
    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: earlierAnswer,
      payload: setReplyPayloadMetadata({ text: earlierAnswer }, { precedingInputAnswer: true }),
      infoKind: "final",
    });
    expect(expectPreviewFinalized(result).content).toBe(earlierAnswer);
  });

  it("createLaneTextDeliverer keeps a preceding input answer's caption when its media follows an active preview", async () => {
    const earlierAnswer =
      "Here is the earlier answer with enough stable prefix text before the ellipsis...";
    const latestAnswer =
      "Here is the earlier answer with enough stable prefix text before the ellipsis and a much longer answer to the next question.";
    const answer = createTestDraftStream({ messageId: 999 });
    answer.update(latestAnswer);
    const harness = createHarness({
      answerStream: answer,
      resolveFinalPayloadCandidate: ({ payload }) => ({ ...payload, text: latestAnswer }),
    });
    harness.lanes.answer.hasStreamedMessage = true;
    await harness.deliverLaneText({
      laneName: "answer",
      text: earlierAnswer,
      payload: setReplyPayloadMetadata(
        { text: earlierAnswer, mediaUrls: ["/tmp/earlier-answer.jpg"] },
        { precedingInputAnswer: true },
      ),
      infoKind: "final",
    });
    expect(harness.answer?.update).toHaveBeenLastCalledWith(earlierAnswer);
    expect(harness.answer?.update).not.toHaveBeenCalledWith(latestAnswer.trimEnd() + "\n");
  });
});
