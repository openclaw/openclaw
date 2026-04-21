import { describe, expect, it } from "vitest";
import {
  FeishuStreamingSession,
  mergeStreamingText,
  resolveStreamingCardSendMode,
} from "./streaming-card.js";

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });

  it("keeps previous text when the next partial is empty or redundant", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello world", "hello")).toBe("hello world");
  });

  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });

  it("merges overlap between adjacent partial snapshots", () => {
    expect(mergeStreamingText("好的，让我", "让我再读取一遍")).toBe("好的，让我再读取一遍");
    expect(mergeStreamingText("revision_id: 552", "2，一点变化都没有")).toBe(
      "revision_id: 552，一点变化都没有",
    );
    expect(mergeStreamingText("abc", "cabc")).toBe("cabc");
  });
});

describe("resolveStreamingCardSendMode", () => {
  it("prefers message.reply when reply target and root id both exist", () => {
    expect(
      resolveStreamingCardSendMode({
        replyToMessageId: "om_parent",
        rootId: "om_topic_root",
      }),
    ).toBe("reply");
  });

  it("falls back to root create when reply target is absent", () => {
    expect(
      resolveStreamingCardSendMode({
        rootId: "om_topic_root",
      }),
    ).toBe("root_create");
  });

  it("uses create mode when no reply routing fields are provided", () => {
    expect(resolveStreamingCardSendMode()).toBe("create");
    expect(
      resolveStreamingCardSendMode({
        replyInThread: true,
      }),
    ).toBe("create");
  });
});

describe("FeishuStreamingSession.clearText", () => {
  it("drops buffered text so recovered finals can overwrite stale partials", async () => {
    const session = new FeishuStreamingSession({} as never, {
      appId: "app_id",
      appSecret: "app_secret",
    });
    const state = session as unknown as {
      state: {
        cardId: string;
        messageId: string;
        sequence: number;
        currentText: string;
        hasNote: boolean;
      } | null;
      pendingText: string | null;
      queue: Promise<void>;
      flushTimer: ReturnType<typeof setTimeout> | null;
      lastUpdateTime: number;
    };

    state.state = {
      cardId: "card_1",
      messageId: "om_1",
      sequence: 1,
      currentText: "partial answer",
      hasNote: false,
    };
    state.pendingText = "partial answer with pending suffix";
    state.lastUpdateTime = Date.now();
    state.flushTimer = setTimeout(() => undefined, 1000);
    state.queue = Promise.resolve();

    await session.clearText();

    expect(state.state?.currentText).toBe("");
    expect(state.pendingText).toBeNull();
    expect(state.lastUpdateTime).toBe(0);
    expect(state.flushTimer).toBeNull();
  });
});
