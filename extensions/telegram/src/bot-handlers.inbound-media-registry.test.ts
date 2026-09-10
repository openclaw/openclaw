import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createTelegramMediaGroupRegistry } from "./bot-handlers.inbound-media-registry.js";
import type { BufferedMediaGroupEntry } from "./bot-handlers.inbound-media.types.js";

describe("createTelegramMediaGroupRegistry", () => {
  it("attempts every album privacy purge before reporting failures", async () => {
    const messages = [1, 2].map(
      (messageId) =>
        ({
          chat: { id: 42, type: "private", first_name: "Ada" },
          date: 1_736_371_600,
          message_id: messageId,
        }) as Message,
    );
    const attempts: string[] = [];
    const groupHistoryError = new Error("group history unavailable");
    const replyCacheError = new Error("reply cache unavailable");
    const removeMessageFromGroupHistory = vi.fn((msg: Message) => {
      attempts.push(`group:${msg.message_id}`);
      if (msg.message_id === 1) {
        throw groupHistoryError;
      }
      return true;
    });
    const removeMessageFromReplyChain = vi.fn(async (msg: Message) => {
      attempts.push(`reply:${msg.message_id}`);
      if (msg.message_id === 1) {
        throw replyCacheError;
      }
      return true;
    });
    const registry = createTelegramMediaGroupRegistry({
      timeoutMs: 10,
      releaseDispatchDedupeClaims: vi.fn(),
      removeMessageFromGroupHistory,
      removeMessageFromReplyChain,
      settleSpooledReplayParticipants: vi.fn(),
    });

    const failure = await registry
      .purgeEntry({
        messages: messages.map((msg) => ({ msg })),
        threadSpec: { scope: "none" },
      } as BufferedMediaGroupEntry)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([groupHistoryError, replyCacheError]);
    expect(attempts).toEqual(["group:1", "reply:1", "group:2", "reply:2"]);
  });
});
