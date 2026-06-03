import { describe, expect, it, vi } from "vitest";
import {
  deliverNativeCommandAckFallback,
  shouldDeliverNativeCommandAckFallback,
} from "./native-command-ack-fallback.js";

describe("native-command-ack-fallback", () => {
  it("detects status-notice command ack payloads", () => {
    expect(
      shouldDeliverNativeCommandAckFallback({
        text: "⚙️ Compaction skipped: already_compacted_recently • ctx 0%",
        isStatusNotice: true,
      }),
    ).toBe(true);
    expect(shouldDeliverNativeCommandAckFallback({ text: "hello" })).toBe(false);
  });

  it("delivers captured command ack when primary dispatch did not", async () => {
    const deliverReplies = vi.fn(async () => ({ delivered: true }));
    const delivered = await deliverNativeCommandAckFallback({
      reply: {
        text: "⚙️ Compaction skipped: already_compacted_recently • ctx 0%",
        isStatusNotice: true,
      },
      delivered: false,
      replyToMessageId: "42",
      deliverReplies,
    });
    expect(delivered).toBe(true);
    expect(deliverReplies).toHaveBeenCalledWith({
      replies: [
        {
          text: "⚙️ Compaction skipped: already_compacted_recently • ctx 0%",
          isStatusNotice: true,
          replyToId: "42",
        },
      ],
    });
  });
});
