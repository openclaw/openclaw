import { expect, onTestFinished, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";

type Options = Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId"> & {
  runId?: string;
};
type BlockReply = NonNullable<Options["onBlockReply"]>;

export function createDeliveryHarness(options: Options = {}) {
  const onBlockReply = vi.fn<BlockReply>();
  const h = createSubscribedSessionHarness({
    runId: "run",
    onBlockReply,
    blockReplyBreak: "text_end",
    ...options,
  });
  onTestFinished(() => h.subscription.unsubscribe());
  const texts = () => extractTextPayloads(onBlockReply.mock.calls);
  const update = (message: unknown, assistantMessageEvent: unknown) =>
    h.emit({ type: "message_update", message, assistantMessageEvent });
  return {
    ...h,
    onBlockReply,
    texts,
    update,
    start: (message: unknown = { role: "assistant" }) => h.emit({ type: "message_start", message }),
    end: (message: unknown) => h.emit({ type: "message_end", message }),
    textUpdate: (
      message: unknown,
      type: "thinking_end" | "text_delta" | "text_end",
      text: string,
      contentIndex?: number,
    ) =>
      update(message, {
        type,
        contentIndex,
        ...(type === "text_delta" ? { delta: text } : { content: text }),
      }),
    flush: async (expected: readonly string[], history = false, calls?: number) => {
      await h.subscription.waitForPendingEvents();
      expect(texts()).toEqual(expected);
      if (history) {
        expect(h.subscription.assistantTexts).toEqual(expected);
      }
      if (calls !== undefined) {
        expect(onBlockReply).toHaveBeenCalledTimes(calls);
      }
    },
  };
}
