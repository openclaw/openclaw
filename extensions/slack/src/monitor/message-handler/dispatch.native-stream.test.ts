import { expect, it } from "vitest";
import {
  appendSlackStreamMock,
  deliverRepliesMock,
  dispatchNativeProgressScenario,
  expectNativeStreamText,
  FINAL_REPLY_TEXT,
  harness,
  sleepRealMs,
  startSlackStreamMock,
  stopSlackStreamMock,
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
