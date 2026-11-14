import { expect, it } from "vitest";
import {
  appendSlackStreamMock,
  deliverRepliesMock,
  dispatchNativeProgressScenario,
  expectDeliverReplyCall,
  expectNativeStreamText,
  FINAL_REPLY_TEXT,
  harness,
  sleepRealMs,
  startSlackStreamMock,
  stopSlackStreamMock,
  TestSlackStreamMessageTooLongError,
} from "./dispatch.native-stream.test-support.js";
import { requireRecord } from "./dispatch.preview.test-support.js";

it("keeps the native final on its stream when a draft boundary lands during final delivery", async () => {
  let finalAppendInFlight = false;
  let stoppedUnderFinalAppend = false;
  appendSlackStreamMock.mockImplementation(async (input) => {
    if (requireRecord(input, "native append").text !== `\n${FINAL_REPLY_TEXT}`) {
      return;
    }
    finalAppendInFlight = true;
    // Core fires the boundary callbacks best effort, without awaiting them.
    void harness.capturedReplyOptions?.onReasoningEnd?.();
    await sleepRealMs(20);
    finalAppendInFlight = false;
  });
  stopSlackStreamMock.mockImplementation(async () => {
    stoppedUnderFinalAppend ||= finalAppendInFlight;
    return {};
  });

  await dispatchNativeProgressScenario({
    events: [{ kind: "item", progressText: "slow tool" }],
    finalPayload: { text: FINAL_REPLY_TEXT },
  });
  // The late boundary settles after dispatch returns.
  await sleepRealMs(30);

  expect(stoppedUnderFinalAppend).toBe(false);
  expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
  expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("posts the native final normally when Slack rejects it with msg_too_long", async () => {
  appendSlackStreamMock.mockImplementation(async (input) => {
    if (requireRecord(input, "native append").text === `\n${FINAL_REPLY_TEXT}`) {
      throw new TestSlackStreamMessageTooLongError(FINAL_REPLY_TEXT);
    }
  });

  await dispatchNativeProgressScenario({
    events: [{ kind: "item", progressText: "slow tool" }],
    finalPayload: { text: FINAL_REPLY_TEXT },
  });

  // A stop first would flush the rejected text again; it follows the post.
  expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
  expect(stopSlackStreamMock.mock.invocationCallOrder[0]).toBeGreaterThan(
    deliverRepliesMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
});

it("stops the native stream without its closeout when Slack rejects it with msg_too_long", async () => {
  stopSlackStreamMock.mockImplementationOnce(async (params) => {
    if (requireRecord(params, "native stop").chunks) {
      throw new TestSlackStreamMessageTooLongError("");
    }
    return {};
  });

  await dispatchNativeProgressScenario({ events: [{ kind: "item", progressText: "slow tool" }] });

  expect(stopSlackStreamMock).toHaveBeenCalledTimes(2);
  expect(requireRecord(stopSlackStreamMock.mock.calls[0]?.[0], "closeout").chunks).toBeDefined();
  expect(requireRecord(stopSlackStreamMock.mock.calls[1]?.[0], "retry").chunks).toBeUndefined();
});

it("keeps every step of an oversized initial plan in default narration mode", async () => {
  // Twenty 120-character CJK steps are about 7,200 bytes: past the 6,000-byte
  // row budget a cards-mode message holds, but narration has no such budget.
  const steps = Array.from({ length: 20 }, (_, index) => ({
    step: `${index + 1}`.padEnd(120, "漢"),
    status: "pending" as const,
  }));
  await dispatchNativeProgressScenario({
    events: [{ kind: "plan", phase: "update", explanation: "Plan", steps }],
    finalPayload: { text: FINAL_REPLY_TEXT },
  });

  expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
  const opening = requireRecord(startSlackStreamMock.mock.calls[0]?.[0], "start");
  const planRows = (opening.chunks as Array<{ id?: unknown }>).filter((chunk) =>
    String(chunk.id).startsWith("plan_step_"),
  );
  expect(planRows).toHaveLength(20);
});
