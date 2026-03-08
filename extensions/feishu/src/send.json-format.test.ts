/**
 * Tests for JSON format safety in Feishu message construction.
 *
 * Covers: sanitizeFeishuText, buildFeishuPostMessagePayload, buildMarkdownCard,
 * and the sendMessageFeishu / sendMarkdownCardFeishu outbound paths with edge-
 * case inputs that previously caused malformed JSON to leak into conversations.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
// --- direct unit imports (no mocking needed) ---
import { sanitizeFeishuText, buildFeishuPostMessagePayload, buildMarkdownCard } from "./send.js";

// ---------------------------------------------------------------------------
// sanitizeFeishuText
// ---------------------------------------------------------------------------
describe("sanitizeFeishuText", () => {
  it("preserves normal text", () => {
    expect(sanitizeFeishuText("hello world")).toBe("hello world");
  });

  it("preserves newlines, carriage returns, and tabs", () => {
    expect(sanitizeFeishuText("line1\nline2\r\nline3\ttab")).toBe("line1\nline2\r\nline3\ttab");
  });

  it("strips null bytes", () => {
    expect(sanitizeFeishuText("he\x00llo")).toBe("hello");
  });

  it("strips control characters U+0001–U+0008, U+000B, U+000C, U+000E–U+001F", () => {
    const dirty = "a\x01b\x02c\x07d\x08e\x0Bf\x0Cg\x0Eh\x1Fi";
    expect(sanitizeFeishuText(dirty)).toBe("abcdefghi");
  });

  it("handles empty string", () => {
    expect(sanitizeFeishuText("")).toBe("");
  });

  it("handles text that is only control characters", () => {
    expect(sanitizeFeishuText("\x00\x01\x02\x03")).toBe("");
  });

  it("preserves unicode and emoji", () => {
    expect(sanitizeFeishuText("你好世界 🎉")).toBe("你好世界 🎉");
  });

  it("preserves markdown special characters", () => {
    expect(sanitizeFeishuText("**bold** _italic_ `code` [link](url)")).toBe(
      "**bold** _italic_ `code` [link](url)",
    );
  });
});

// ---------------------------------------------------------------------------
// buildFeishuPostMessagePayload
// ---------------------------------------------------------------------------
describe("buildFeishuPostMessagePayload", () => {
  it("produces valid JSON for normal text", () => {
    const { content, msgType } = buildFeishuPostMessagePayload({ messageText: "hello" });
    expect(msgType).toBe("post");

    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0][0]).toEqual({ tag: "md", text: "hello" });
  });

  it("coalesces undefined messageText to empty string", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { content } = buildFeishuPostMessagePayload({ messageText: undefined as any });
    const parsed = JSON.parse(content);
    // The `text` key must be present (not stripped by JSON.stringify).
    expect(parsed.zh_cn.content[0][0]).toHaveProperty("text", "");
  });

  it("coalesces null messageText to empty string", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { content } = buildFeishuPostMessagePayload({ messageText: null as any });
    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0][0]).toHaveProperty("text", "");
  });

  it("strips control characters from text", () => {
    const { content } = buildFeishuPostMessagePayload({ messageText: "a\x00b\x01c" });
    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0][0].text).toBe("abc");
  });

  it("handles text with embedded JSON", () => {
    const msg = 'The API returns: {"code": 0, "msg": "success"}';
    const { content } = buildFeishuPostMessagePayload({ messageText: msg });
    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0][0].text).toBe(msg);
  });

  it("handles text with quotes and backslashes", () => {
    const msg = 'She said "hello\\nworld"';
    const { content } = buildFeishuPostMessagePayload({ messageText: msg });
    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0][0].text).toBe(msg);
  });

  it("handles text with triple backticks (code blocks)", () => {
    const msg = "```python\ndef f():\n  pass\n```";
    const { content } = buildFeishuPostMessagePayload({ messageText: msg });
    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0][0].text).toBe(msg);
  });

  it("handles text with markdown tables", () => {
    const msg = "| a | b |\n| - | - |\n| 1 | 2 |";
    const { content } = buildFeishuPostMessagePayload({ messageText: msg });
    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0][0].text).toBe(msg);
  });

  it("handles text with Feishu at-mention markup", () => {
    const msg = '<at user_id="ou_abc">Alice</at> hello';
    const { content } = buildFeishuPostMessagePayload({ messageText: msg });
    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0][0].text).toBe(msg);
  });

  it("handles multiline text with various newline styles", () => {
    const msg = "line1\nline2\r\nline3\rline4";
    const { content } = buildFeishuPostMessagePayload({ messageText: msg });
    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0][0].text).toBe(msg);
  });

  it("handles very long text", () => {
    const msg = "a".repeat(10000);
    const { content } = buildFeishuPostMessagePayload({ messageText: msg });
    const parsed = JSON.parse(content);
    expect(parsed.zh_cn.content[0][0].text).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// buildMarkdownCard
// ---------------------------------------------------------------------------
describe("buildMarkdownCard", () => {
  it("produces a valid card object for normal text", () => {
    const card = buildMarkdownCard("hello");
    expect(card.schema).toBe("2.0");
    const body = card.body as { elements: Array<{ tag: string; content: string }> };
    expect(body.elements[0]).toEqual({ tag: "markdown", content: "hello" });
  });

  it("coalesces undefined text to empty string", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const card = buildMarkdownCard(undefined as any);
    const body = card.body as { elements: Array<{ tag: string; content: string }> };
    expect(body.elements[0]).toHaveProperty("content", "");
  });

  it("strips control characters from card text", () => {
    const card = buildMarkdownCard("x\x00y\x01z");
    const body = card.body as { elements: Array<{ tag: string; content: string }> };
    expect(body.elements[0].content).toBe("xyz");
  });

  it("serializes to valid JSON with embedded JSON text", () => {
    const card = buildMarkdownCard('Result: {"ok":true}');
    const json = JSON.stringify(card);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.body.elements[0].content).toBe('Result: {"ok":true}');
  });

  it("serializes to valid JSON with quotes and backslashes", () => {
    const card = buildMarkdownCard('She said "hi" and path is C:\\Users\\foo');
    const json = JSON.stringify(card);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sendMessageFeishu — verify the content structure sent to the Feishu API
// ---------------------------------------------------------------------------
const resolveFeishuSendTargetMock = vi.hoisted(() => vi.fn());
const resolveMarkdownTableModeMock = vi.hoisted(() => vi.fn(() => "preserve"));
const convertMarkdownTablesMock = vi.hoisted(() => vi.fn((text: string) => text));

vi.mock("./send-target.js", () => ({
  resolveFeishuSendTarget: resolveFeishuSendTargetMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: resolveMarkdownTableModeMock,
        convertMarkdownTables: convertMarkdownTablesMock,
      },
    },
  }),
}));

import { sendMessageFeishu, sendMarkdownCardFeishu } from "./send.js";

describe("sendMessageFeishu JSON format safety", () => {
  const createMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuSendTargetMock.mockReturnValue({
      client: {
        im: { message: { create: createMock, reply: vi.fn() } },
      },
      receiveId: "oc_test",
      receiveIdType: "chat_id",
    });
    createMock.mockResolvedValue({ code: 0, data: { message_id: "om_ok" } });
  });

  it("sends valid JSON content for normal text", async () => {
    await sendMessageFeishu({ cfg: {} as never, to: "chat:oc_test", text: "hello" });

    expect(createMock).toHaveBeenCalledTimes(1);
    const sentData = createMock.mock.calls[0][0].data;
    expect(sentData.msg_type).toBe("post");
    expect(() => JSON.parse(sentData.content)).not.toThrow();
    const parsed = JSON.parse(sentData.content);
    expect(parsed.zh_cn.content[0][0].text).toBe("hello");
  });

  it("sends valid JSON content for text with control characters", async () => {
    await sendMessageFeishu({
      cfg: {} as never,
      to: "chat:oc_test",
      text: "a\x00b\x01c\x02d",
    });

    const sentData = createMock.mock.calls[0][0].data;
    const parsed = JSON.parse(sentData.content);
    expect(parsed.zh_cn.content[0][0].text).toBe("abcd");
  });

  it("sends valid JSON for text with embedded JSON/quotes/backslashes", async () => {
    const tricky = 'Result: {"status":"ok"}, path: C:\\tmp\\file, say "hi"';
    await sendMessageFeishu({ cfg: {} as never, to: "chat:oc_test", text: tricky });

    const sentData = createMock.mock.calls[0][0].data;
    expect(() => JSON.parse(sentData.content)).not.toThrow();
    const parsed = JSON.parse(sentData.content);
    expect(parsed.zh_cn.content[0][0].text).toBe(tricky);
  });

  it("sends valid JSON when text is undefined (defensive)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendMessageFeishu({ cfg: {} as never, to: "chat:oc_test", text: undefined as any });

    const sentData = createMock.mock.calls[0][0].data;
    const parsed = JSON.parse(sentData.content);
    // text key must be present
    expect(parsed.zh_cn.content[0][0]).toHaveProperty("text");
  });

  it("handles convertMarkdownTables returning undefined gracefully", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    convertMarkdownTablesMock.mockReturnValueOnce(undefined as any);

    await sendMessageFeishu({ cfg: {} as never, to: "chat:oc_test", text: "some text" });

    const sentData = createMock.mock.calls[0][0].data;
    const parsed = JSON.parse(sentData.content);
    expect(parsed.zh_cn.content[0][0]).toHaveProperty("text", "");
  });
});

describe("sendMarkdownCardFeishu JSON format safety", () => {
  const createMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuSendTargetMock.mockReturnValue({
      client: {
        im: { message: { create: createMock, reply: vi.fn() } },
      },
      receiveId: "oc_test",
      receiveIdType: "chat_id",
    });
    createMock.mockResolvedValue({ code: 0, data: { message_id: "om_card" } });
  });

  it("sends valid interactive card JSON", async () => {
    await sendMarkdownCardFeishu({
      cfg: {} as never,
      to: "chat:oc_test",
      text: "**bold** `code`",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const sentData = createMock.mock.calls[0][0].data;
    expect(sentData.msg_type).toBe("interactive");
    expect(() => JSON.parse(sentData.content)).not.toThrow();
    const parsed = JSON.parse(sentData.content);
    expect(parsed.schema).toBe("2.0");
    expect(parsed.body.elements[0].content).toBe("**bold** `code`");
  });

  it("sends valid card JSON for text with control characters", async () => {
    await sendMarkdownCardFeishu({
      cfg: {} as never,
      to: "chat:oc_test",
      text: "a\x00b\x01c",
    });

    const sentData = createMock.mock.calls[0][0].data;
    const parsed = JSON.parse(sentData.content);
    expect(parsed.body.elements[0].content).toBe("abc");
  });

  it("sends valid card JSON for text with embedded JSON", async () => {
    const msg = '{"error":"bad request","code":400}';
    await sendMarkdownCardFeishu({ cfg: {} as never, to: "chat:oc_test", text: msg });

    const sentData = createMock.mock.calls[0][0].data;
    expect(() => JSON.parse(sentData.content)).not.toThrow();
    const parsed = JSON.parse(sentData.content);
    expect(parsed.body.elements[0].content).toBe(msg);
  });
});
