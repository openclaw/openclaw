import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";

function createClientMock() {
  const messageDelete = vi.fn(async () => ({ code: 0, msg: "ok" }));
  const messageCreate = vi.fn(async () => ({
    code: 0,
    msg: "ok",
    data: { message_id: "message-id" },
  }));
  const messageReply = vi.fn(async () => ({
    code: 0,
    msg: "ok",
    data: { message_id: "message-id" },
  }));
  const cardCreate = vi.fn(async () => ({ code: 0, msg: "ok", data: { card_id: "card-id" } }));
  const cardSettings = vi.fn(async () => ({ code: 0, msg: "ok" }));
  const cardElementContent = vi.fn(async () => ({ code: 0, msg: "ok" }));

  const client = {
    im: {
      message: {
        delete: messageDelete,
        create: messageCreate,
        reply: messageReply,
      },
    },
    cardkit: {
      v1: {
        card: {
          create: cardCreate,
          settings: cardSettings,
        },
        cardElement: {
          content: cardElementContent,
        },
      },
    },
  };

  return {
    client: client as never,
    messageDelete,
    messageCreate,
    messageReply,
    cardCreate,
    cardSettings,
    cardElementContent,
  };
}

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
});

describe("FeishuStreamingSession.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supports replace mode to overwrite transient status text", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.update("🔧 正在使用Read工具...", { mode: "replace" });

    expect(updateCardContentSpy).toHaveBeenCalledWith(
      "🔧 正在使用Read工具...",
      expect.any(Function),
    );
    expect((session as any).state.currentText).toBe("🔧 正在使用Read工具...");
  });
});

describe("FeishuStreamingSession.discard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the interactive message instead of leaving an empty card", async () => {
    const { client, messageDelete } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };

    await session.discard();

    expect(messageDelete).toHaveBeenCalledWith({
      path: { message_id: "message-id" },
    });
  });
});

describe("FeishuStreamingSession.close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats explicit empty final text as authoritative", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };
    (session as any).pendingUpdate = { text: "💭 思考中...", mode: "replace" };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.close("");

    expect(updateCardContentSpy).toHaveBeenCalledWith("");
    expect((session as any).state.currentText).toBe("");
  });

  it("keeps pending merge behavior when final text is omitted", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "第一段",
    };
    (session as any).pendingUpdate = { text: "第一段\n第二段", mode: "merge" };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.close();

    expect(updateCardContentSpy).toHaveBeenCalledWith("第一段\n第二段");
    expect((session as any).state.currentText).toBe("第一段\n第二段");
  });

  it("respects pending replace updates when final text is omitted", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };
    (session as any).pendingUpdate = { text: "🔧 正在使用Read工具...", mode: "replace" };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.close();

    expect(updateCardContentSpy).toHaveBeenCalledWith("🔧 正在使用Read工具...");
    expect((session as any).state.currentText).toBe("🔧 正在使用Read工具...");
  });
});
