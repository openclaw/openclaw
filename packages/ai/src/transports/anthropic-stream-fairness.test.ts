import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  anthropicModel,
  context,
  anthropicEvents,
  createAnthropicResponse,
  registerParityHostLifecycle,
} from "../provider-transport-parity.test-support.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

registerParityHostLifecycle();
afterEach(() => vi.useRealTimers());

describe("Anthropic stream fairness", () => {
  it.each([false, true])("yields buffered events before completion (abort=%s)", async (abort) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const scheduled = createDeferred();
    const setTimer = globalThis.setTimeout;
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        scheduled.resolve();
        return setTimer(callback, delay, ...args);
      });
    const controller = new AbortController();
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => async () =>
        createAnthropicResponse([
          ...anthropicEvents.slice(0, 1),
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          ...Array.from({ length: 128 }, () => ({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "x" },
          })),
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
          { type: "message_stop" },
        ]),
    });
    try {
      const stream = await createAnthropicMessagesTransportStreamFn()(anthropicModel, context, {
        apiKey: "test-key",
        signal: controller.signal,
      });
      const completion = stream.result();
      expect(
        await Promise.race([
          scheduled.promise.then(() => "yield"),
          completion.then(() => "completed"),
        ]),
      ).toBe("yield");
      if (abort) {
        controller.abort();
      }
      await vi.runAllTimersAsync();
      const result = await completion;
      expect(result.stopReason).toBe(abort ? "aborted" : "stop");
      if (!abort) {
        expect(result.content).toEqual([{ type: "text", text: "x".repeat(128) }]);
      }
    } finally {
      await vi.runAllTimersAsync();
      timer.mockRestore();
    }
  });
});
