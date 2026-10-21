import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAttemptParams } from "./lifecycle.test-support.js";
import { AgentHarnessProjectionSettlement } from "./projection-settlement.js";

it("drains concurrent presentation callbacks and refuses new presentation after close", async () => {
  const first = createDeferred();
  const second = createDeferred();
  let active = true;
  const onPartialReply = vi.fn(({ text }: { text?: string }) =>
    text === "first" ? first.promise : second.promise,
  );
  const settlement = new AgentHarnessProjectionSettlement(
    { ...createAttemptParams(), onPartialReply },
    () => active,
    { label: "test harness" },
  );
  void settlement.params.onPartialReply?.({ text: "first" });
  void settlement.params.onPartialReply?.({ text: "second" });
  expect(onPartialReply.mock.calls.map(([payload]) => payload.text)).toEqual(["first", "second"]);
  let drained = false;
  const drain = settlement.drain().then(() => {
    drained = true;
  });
  second.resolve();
  await second.promise;
  expect(drained).toBe(false);
  active = false;
  void settlement.params.onPartialReply?.({ text: "closed" });
  expect(onPartialReply).toHaveBeenCalledTimes(2);
  first.resolve();
  await drain;
  expect(settlement.pendingStage).toBeUndefined();
});

it.each([false, true])(
  "settles failed presentation callbacks (asynchronous=%s)",
  async (asyncFailure) => {
    const error = new Error("presentation unavailable");
    const settlement = new AgentHarnessProjectionSettlement(
      {
        ...createAttemptParams(),
        onAssistantMessageStart: () => {
          if (asyncFailure) {
            return Promise.reject(error);
          }
          throw error;
        },
      },
      () => true,
      { label: "test harness" },
    );
    expect(() => settlement.params.onAssistantMessageStart?.()).not.toThrow();
    await settlement.drain();
    expect(settlement.pendingStage).toBeUndefined();
  },
);
