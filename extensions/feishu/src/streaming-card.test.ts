import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FeishuStreamingSession,
  mergeStreamingText,
  resolveStreamingCardSendMode,
} from "./streaming-card.js";

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
  const cardSettings = vi.fn(async (_arg: { path?: unknown; data?: { settings?: string } }) => ({
    code: 0,
    msg: "ok",
  }));
  const cardUpdate = vi.fn(async () => ({ code: 0, msg: "ok" }));
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
          update: cardUpdate,
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
    cardUpdate,
    cardElementContent,
  };
}

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });

  it("keeps previous text when the next partial is empty or identical", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello", "hello")).toBe("hello");
  });

  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });

  it("treats overlapping delta chunks as plain appends to preserve markdown", () => {
    // Delta streams from model-aware-runner emit token fragments that may
    // share characters at chunk boundaries (e.g. `|` separators in markdown
    // tables, or `l` in `install` + `lossless`).  A tail-head overlap collapse
    // would eat real content — the simple append below is the correct
    // behavior for genuine delta streams and preserves NO_REPLY-style token
    // splits like "NO" + "_REPLY" → "NO_REPLY".
    expect(mergeStreamingText("install", "lossless")).toBe("installlossless");
    expect(mergeStreamingText("abc| |", "| |xyz")).toBe("abc| || |xyz");
    expect(mergeStreamingText("NO", "_REPLY")).toBe("NO_REPLY");
    // Delta tokens must never be swallowed even if they appear as substrings
    // of accumulated text — single chars like "|", "\n", "-" repeat constantly
    // in markdown tables.
    expect(mergeStreamingText("| col1 | col2 |", "|")).toBe("| col1 | col2 ||");
    expect(mergeStreamingText("line1\n", "\n")).toBe("line1\n\n");
    expect(mergeStreamingText("a b c", " ")).toBe("a b c ");
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
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.update("🔧 正在使用Read工具...", { replace: true });

    expect(updateCardContentSpy).toHaveBeenCalledWith(
      "🔧 正在使用Read工具...",
      expect.any(Function),
    );
    expect((session as any).state.currentText).toBe("🔧 正在使用Read工具...");
  });

  it("passes raw replace-mode content through unchanged to preserve markdown", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    const markdown =
      "当前共有 **28** 个 skills:\n\n| 类别 | 数量 |\n|------|------|\n| 开发工具 | 5 |";
    await session.update(markdown, { replace: true });

    expect(updateCardContentSpy).toHaveBeenCalledWith(markdown, expect.any(Function));
    expect((session as any).state.currentText).toBe(markdown);
  });

  it("stores a custom thinking panel title for tool-only updates", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
      hasNote: false,
      noteText: "",
    };
    const updateCardFullSpy = vi.spyOn(session as any, "updateCardFull").mockResolvedValue(true);

    await session.updateThinking("1. Bash\n\n⏳ Running Bash...", {
      title: "🔧 Tool calls (1)",
    });

    expect(updateCardFullSpy).toHaveBeenCalled();
    expect((session as any).state.thinkingTitle).toBe("🔧 Tool calls (1)");
  });

  it("updates thinking content via element API after the panel is already rendered", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "answer",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "first thought",
      thinkingExpanded: true,
      thinkingPanelRendered: true,
    };
    const updateCardFullSpy = vi.spyOn(session as any, "updateCardFull").mockResolvedValue(true);
    const updateElementSpy = vi
      .spyOn(session as any, "updateElementContent")
      .mockResolvedValue(true);

    await session.updateThinking("second thought", { title: "💭 Thinking" });

    expect(updateCardFullSpy).not.toHaveBeenCalled();
    expect(updateElementSpy).toHaveBeenCalledWith(
      "thinking_content",
      "second thought",
      expect.any(Function),
    );
  });

  it("passes thinking content through unchanged (directive stripping deferred to upstream)", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "answer",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "first thought",
      thinkingExpanded: true,
      thinkingPanelRendered: true,
    };
    const updateElementSpy = vi
      .spyOn(session as any, "updateElementContent")
      .mockResolvedValue(true);

    await session.updateThinking("[[reply_to_current]] 让我去扒一下这个项目。", {
      title: "💭 Thinking",
    });

    // Raw text passes through — directive tags are stripped by the
    // reply-dispatcher at final delivery, not inside the streaming session.
    expect(updateElementSpy).toHaveBeenCalledWith(
      "thinking_content",
      "[[reply_to_current]] 让我去扒一下这个项目。",
      expect.any(Function),
    );
    expect((session as any).state.thinkingText).toBe("[[reply_to_current]] 让我去扒一下这个项目。");
  });

  it("rolls back thinking state after a failed full-card update so identical retries are still allowed", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "answer",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "old",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    const updateCardFullSpy = vi
      .spyOn(session as any, "updateCardFull")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await session.updateThinking("new", { title: "🔧 Tool calls (1)" });
    expect((session as any).state.thinkingText).toBe("old");
    expect((session as any).state.thinkingTitle).toBe("💭 Thinking");

    await session.updateThinking("new", { title: "🔧 Tool calls (1)" });
    expect(updateCardFullSpy).toHaveBeenCalledTimes(2);
    expect((session as any).state.thinkingText).toBe("new");
    expect((session as any).state.thinkingTitle).toBe("🔧 Tool calls (1)");
  });

  it("rolls back thinking state after an element update failure so identical retries are still allowed", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "answer",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "old",
      thinkingExpanded: true,
      thinkingPanelRendered: true,
    };
    const updateElementSpy = vi
      .spyOn(session as any, "updateElementContent")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await session.updateThinking("new", { title: "💭 Thinking" });
    expect((session as any).state.thinkingText).toBe("old");

    await session.updateThinking("new", { title: "💭 Thinking" });
    expect(updateElementSpy).toHaveBeenCalledTimes(2);
    expect((session as any).state.thinkingText).toBe("new");
  });

  it("reopens streaming mode and retries once when text streaming times out", async () => {
    const { client, cardElementContent, cardSettings } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 2,
      currentText: "answer",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();
    cardElementContent
      .mockResolvedValueOnce({ code: 200850, msg: "Card streaming timeout" })
      .mockResolvedValueOnce({ code: 0, msg: "ok" });

    const ok = await (session as any).updateElementContent("content", "updated", vi.fn());

    expect(ok).toBe(true);
    expect(cardSettings).toHaveBeenCalledOnce();
    expect(cardElementContent).toHaveBeenCalledTimes(2);
    const reopenArg = cardSettings.mock.calls[0]?.[0] as {
      data?: { settings?: string; sequence?: number };
    };
    const reopenSettings = JSON.parse(reopenArg.data?.settings ?? "{}") as {
      config?: { streaming_mode?: boolean };
    };
    expect(reopenSettings.config?.streaming_mode).toBe(true);
    expect(reopenArg.data?.sequence).toBe(3);
    const retryCalls = cardElementContent.mock.calls as unknown as Array<[unknown]>;
    const retryArg = retryCalls[1]?.[0] as unknown as {
      data?: { sequence?: number };
    };
    expect(retryArg.data?.sequence).toBe(4);
    expect((session as any).state.sequence).toBe(4);
  });

  it("reopens streaming mode when the sdk only exposes a closed-streaming error message", async () => {
    const { client, cardElementContent, cardSettings } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 2,
      currentText: "answer",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();
    cardElementContent
      .mockRejectedValueOnce(new Error("ErrMsg: streaming mode is closed;"))
      .mockResolvedValueOnce({ code: 0, msg: "ok" });

    const ok = await (session as any).updateElementContent("content", "updated", vi.fn());

    expect(ok).toBe(true);
    expect(cardSettings).toHaveBeenCalledOnce();
    expect(cardElementContent).toHaveBeenCalledTimes(2);
    expect((session as any).state.sequence).toBe(4);
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
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
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
      thinkingText: "",
      thinkingExpanded: true,
    };
    (session as any).pendingText = "💭 思考中...";
    (session as any).lastStreamingModeRenewAt = Date.now();
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(true);

    await session.close("");

    expect(updateCardContentSpy).toHaveBeenCalledWith("");
  });

  it("treats explicit non-empty final text as authoritative", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "**Checking SEO JSON-LD in PR #16**<at id=ou_luke></at> 加了。",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).pendingText =
      "**Checking SEO JSON-LD in PR #16**<at id=ou_luke></at> 加了。\n我刚";
    (session as any).lastStreamingModeRenewAt = Date.now();
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(true);

    await session.close("<at id=ou_luke></at> 加了。\n我刚又确认了一遍");

    expect(updateCardContentSpy).toHaveBeenCalled();
    const calledText = updateCardContentSpy.mock.calls[0]?.[0] as string;
    expect(calledText).toContain("又确认了一遍");
  });

  it("replaces stale streamed preview text instead of merging it into explicit final text", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...\n\n原因就一个：\n- working tree clean",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(true);

    await session.close("能 review。\n\n原因就一个：\n- working tree clean");

    expect(updateCardContentSpy).toHaveBeenCalledWith(
      "能 review。\n\n原因就一个：\n- working tree clean",
    );
  });

  it("passes final text through unchanged on close (directive stripping deferred to upstream)", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "旧内容",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(true);

    await session.close("[[reply_to_current]] 让我去扒一下这个项目。");

    // Raw text passes through — directive tags are stripped by the
    // reply-dispatcher at final delivery, not inside the streaming session.
    expect(updateCardContentSpy).toHaveBeenCalledWith(
      "[[reply_to_current]] 让我去扒一下这个项目。",
    );
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
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).pendingText = "第一段\n第二段";
    (session as any).lastStreamingModeRenewAt = Date.now();
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(true);

    await session.close();

    expect(updateCardContentSpy).toHaveBeenCalledWith("第一段\n第二段");
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
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    // pendingText is a plain string in the current code — mergeStreamingText
    // will merge it with currentText producing the expected result.
    (session as any).pendingText = "🔧 正在使用Read工具...";
    (session as any).lastStreamingModeRenewAt = Date.now();
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(true);

    await session.close();

    // pendingMerged = mergeStreamingText("💭 思考中...", "🔧 正在使用Read工具...")
    // Neither is a prefix of the other, no overlap → concatenation:
    // "💭 思考中...🔧 正在使用Read工具..."
    // text = pendingMerged (no finalText)
    // text !== currentText → updateCardContent called
    expect(updateCardContentSpy).toHaveBeenCalled();
    const calledText = updateCardContentSpy.mock.calls[0]?.[0] as string;
    expect(calledText).toContain("🔧 正在使用Read工具...");
  });

  it("falls back to full card update when streaming content update fails on close", async () => {
    const { client, cardElementContent, cardUpdate } = createClientMock();
    // Simulate streaming_mode expired — element content API rejects
    cardElementContent.mockRejectedValueOnce(new Error("streaming timeout"));

    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "旧内容",
      header: { title: "Test", template: "blue" },
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();

    await session.close("最终内容");

    // Streaming update was attempted and failed
    expect(cardElementContent).toHaveBeenCalled();
    // Fallback card.update was called with full card JSON
    expect(cardUpdate).toHaveBeenCalledOnce();
    const updateArg = (cardUpdate.mock.calls[0] as unknown[])?.[0] as {
      path?: { card_id?: string };
      data?: { card?: { data?: string } };
    };
    expect(updateArg.path?.card_id).toBe("card-id");
    const cardJson = JSON.parse(updateArg.data?.card?.data ?? "{}") as {
      body?: { elements?: Array<{ content?: string }> };
      header?: { title?: { content?: string } };
    };
    expect(cardJson.body?.elements?.[0]?.content).toBe("最终内容");
    expect(cardJson.header?.title?.content).toBe("Test");
  });

  it("drops a previously rendered thinking panel when close is asked to suppress tool-only UI", async () => {
    const { client, cardUpdate } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "最终答案",
      hasNote: false,
      noteText: "",
      thinkingTitle: "🔧 Tool calls (2)",
      thinkingText: "\u200B",
      thinkingExpanded: true,
      thinkingPanelRendered: true,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();

    await session.close("最终答案", { dropThinkingPanel: true });

    expect(cardUpdate).toHaveBeenCalledOnce();
    const updateArg = (cardUpdate.mock.calls[0] as unknown[])?.[0] as {
      data?: { card?: { data?: string } };
    };
    const cardJson = JSON.parse(updateArg.data?.card?.data ?? "{}") as {
      body?: { elements?: Array<{ tag?: string; content?: string }> };
    };
    expect(cardJson.body?.elements?.some((element) => element.tag === "collapsible_panel")).toBe(
      false,
    );
    expect(cardJson.body?.elements?.find((element) => element.tag === "markdown")?.content).toBe(
      "最终答案",
    );
  });

  it("does not call full card update when streaming content update succeeds and no thinking", async () => {
    const { client, cardUpdate } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "旧内容",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();

    await session.close("最终内容");

    expect(cardUpdate).not.toHaveBeenCalled();
  });

  it("forces a final full card sync on close after an earlier streaming update failure", async () => {
    const { client, cardUpdate } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "最终内容",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).requiresFullCardSync = true;
    (session as any).lastStreamingModeRenewAt = Date.now();

    await session.close("最终内容");

    expect(cardUpdate).toHaveBeenCalledOnce();
  });

  it("strips html tags when writing summary content on close", async () => {
    const { client, cardSettings } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();

    await session.close(
      '<at user_id="ou_user_1">Lukin</at> 已完成 <b>发布</b><br/>请查看 <a href="https://example.com">链接</a>',
    );

    expect(cardSettings).toHaveBeenCalled();
    // The close settings call is the last one; find it
    const lastCallArg = cardSettings.mock.calls[cardSettings.mock.calls.length - 1]?.[0] as {
      data?: { settings?: string };
    };
    const settingsPayload = JSON.parse(lastCallArg.data?.settings ?? "{}") as {
      config?: { summary?: { content?: string } };
    };
    // truncateSummary uses stripHtmlTagsToText which converts <br/> to \n,
    // then \s+ is collapsed to single space.
    const summary = settingsPayload.config?.summary?.content ?? "";
    expect(summary).toBe("Lukin 已完成 发布 请查看 链接");
  });
});

describe("FeishuStreamingSession.renewStreamingMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function makeSession(client: ReturnType<typeof createClientMock>["client"]) {
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 2,
      currentText: "text",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();
    return session;
  }

  it("does not renew when last renewal is within 8 minutes", async () => {
    const { client, cardSettings } = createClientMock();
    const session = makeSession(client);

    await (session as any).renewStreamingMode();

    expect(cardSettings).not.toHaveBeenCalled();
    expect((session as any).state.sequence).toBe(2);
  });

  it("renews and advances sequence when 8 minutes have elapsed", async () => {
    const { client, cardSettings } = createClientMock();
    const session = makeSession(client);
    (session as any).lastStreamingModeRenewAt = Date.now() - 8 * 60 * 1000 - 1;

    await (session as any).renewStreamingMode();

    expect(cardSettings).toHaveBeenCalledOnce();
    const arg = cardSettings.mock.calls[0]?.[0] as {
      data?: { settings?: string; sequence?: number };
    };
    const settings = JSON.parse(arg.data?.settings ?? "{}") as {
      config?: { streaming_mode?: boolean };
    };
    expect(settings.config?.streaming_mode).toBe(true);
    expect(arg.data?.sequence).toBe(3);
    expect((session as any).state.sequence).toBe(3);
  });

  it("does not advance sequence when renewal API returns non-zero code", async () => {
    const { client, cardSettings } = createClientMock();
    cardSettings.mockResolvedValueOnce({ code: 200850, msg: "Card streaming timeout" });
    const session = makeSession(client);
    (session as any).lastStreamingModeRenewAt = Date.now() - 8 * 60 * 1000 - 1;

    await (session as any).renewStreamingMode();

    expect(cardSettings).toHaveBeenCalledOnce();
    expect((session as any).state.sequence).toBe(2);
  });

  it("does not advance sequence when renewal API throws", async () => {
    const { client, cardSettings } = createClientMock();
    cardSettings.mockRejectedValueOnce(new Error("network error"));
    const session = makeSession(client);
    (session as any).lastStreamingModeRenewAt = Date.now() - 8 * 60 * 1000 - 1;

    await (session as any).renewStreamingMode();

    expect((session as any).state.sequence).toBe(2);
  });

  it("updates lastStreamingModeRenewAt only on success", async () => {
    const { client, cardSettings } = createClientMock();
    cardSettings.mockRejectedValueOnce(new Error("network error"));
    const session = makeSession(client);
    const renewedAt = Date.now() - 8 * 60 * 1000 - 1;
    (session as any).lastStreamingModeRenewAt = renewedAt;

    await (session as any).renewStreamingMode();

    expect((session as any).lastStreamingModeRenewAt).toBe(renewedAt);
  });

  it("start() initialises lastStreamingModeRenewAt so first update does not trigger renewal", async () => {
    const { client, cardSettings } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    await session.start("chat-id");

    const before = cardSettings.mock.calls.length;
    await (session as any).updateCardContent("hello");
    expect(cardSettings.mock.calls.length).toBe(before);

    // Clean up timer to avoid leaking
    (session as any).stopRenewTimer();
  });

  it("start() sets up a proactive renew timer", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    await session.start("chat-id");

    expect((session as any).renewTimer).not.toBeNull();

    // Clean up
    (session as any).stopRenewTimer();
  });

  it("close() stops the renew timer", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "text",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();
    (session as any).startRenewTimer();
    expect((session as any).renewTimer).not.toBeNull();

    await session.close("final");

    expect((session as any).renewTimer).toBeNull();
  });

  it("discard() stops the renew timer", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "text",
      hasNote: false,
      noteText: "",
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    (session as any).startRenewTimer();
    expect((session as any).renewTimer).not.toBeNull();

    await session.discard();

    expect((session as any).renewTimer).toBeNull();
  });

  it("proactive timer fires renewStreamingMode after interval elapses", async () => {
    vi.useFakeTimers();
    const { client, cardSettings } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "text",
      thinkingText: "",
      thinkingExpanded: true,
    };
    // Set lastStreamingModeRenewAt to long ago so renewal condition is met
    (session as any).lastStreamingModeRenewAt = 0;
    (session as any).startRenewTimer();

    const before = cardSettings.mock.calls.length;

    // Advance past the renewal interval
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);

    expect(cardSettings.mock.calls.length).toBeGreaterThan(before);
    const arg = cardSettings.mock.calls[cardSettings.mock.calls.length - 1]?.[0] as {
      data?: { settings?: string };
    };
    const settings = JSON.parse(arg.data?.settings ?? "{}") as {
      config?: { streaming_mode?: boolean };
    };
    expect(settings.config?.streaming_mode).toBe(true);

    (session as any).stopRenewTimer();
    vi.useRealTimers();
  });

  it("serializes proactive renewal behind in-flight content updates", async () => {
    let resolveContentUpdate = () => {};
    const contentUpdateSettled = new Promise<void>((resolve) => {
      resolveContentUpdate = () => resolve();
    });
    const { client, cardElementContent, cardSettings } = createClientMock();
    cardElementContent.mockImplementationOnce(
      async () =>
        await contentUpdateSettled.then(() => ({
          code: 0,
          msg: "ok",
        })),
    );
    const session = makeSession(client);
    (session as any).lastStreamingModeRenewAt = Date.now();

    const updatePromise = session.update("new text", { replace: true });
    await Promise.resolve();

    (session as any).lastStreamingModeRenewAt = 0;
    (session as any).scheduleRenewStreamingMode();

    await Promise.resolve();
    expect(cardSettings).not.toHaveBeenCalled();

    resolveContentUpdate();
    await updatePromise;
    await (session as any).queue;

    expect(cardElementContent).toHaveBeenCalledOnce();
    expect(cardSettings).toHaveBeenCalledOnce();
    const contentCalls = cardElementContent.mock.calls as unknown as Array<[unknown]>;
    const contentArg = contentCalls[0]?.[0] as unknown as {
      data?: { sequence?: number };
    };
    const renewArg = cardSettings.mock.calls[0]?.[0] as {
      data?: { sequence?: number };
    };
    expect(contentArg.data?.sequence).toBe(3);
    expect(renewArg.data?.sequence).toBe(4);
    expect((session as any).state.sequence).toBe(4);
  });
});
