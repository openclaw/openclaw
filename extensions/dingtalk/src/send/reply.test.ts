/**
 * Tests for reply via sessionWebhook.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendReplyViaSessionWebhook, sendImageViaSessionWebhook, sendActionCardViaSessionWebhook, resolveResponsePrefix } from "./reply.js";

describe("sendReplyViaSessionWebhook", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends text message via webhook", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendReplyViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      "Hello, world!"
    );

    expect(result.ok).toBe(true);
    expect(result.chunks).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("sendBySession");
    const body = JSON.parse(opts.body);
    expect(body.msgtype).toBe("text");
    expect(body.text.content).toBe("Hello, world!");
  });

  it("sends markdown message", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendReplyViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      "# Title\n\nContent",
      { replyMode: "markdown" }
    );

	    expect(result.ok).toBe(true);
	    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
	    expect(body.msgtype).toBe("markdown");
	    expect(body.markdown.title).toBe("OpenClaw");
	    expect(body.markdown.text).toContain("# Title");
	  });

  it("chunks long messages", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const longText = "A".repeat(4000);
    const result = await sendReplyViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      longText,
      { maxChars: 1800 }
    );

    expect(result.ok).toBe(true);
    expect(result.chunks).toBeGreaterThan(1);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("returns error when sessionWebhook is missing", async () => {
    const result = await sendReplyViaSessionWebhook("", "Hello");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_sessionWebhook");
  });

  it("returns error on HTTP failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad request"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendReplyViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      "Hello"
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("http_error");
    expect(result.status).toBe(400);
  });

  it("returns error on fetch exception", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendReplyViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      "Hello"
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("fetch_error");
  });

  it("converts tables when using markdown mode", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tableText = `Text before

| A | B |
|---|---|
| 1 | 2 |

Text after`;

    await sendReplyViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      tableText,
      { replyMode: "markdown", tableMode: "code" }
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.markdown.text).toContain("```");
  });

  it("does not convert tables when tableMode is off", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tableText = `| A | B |
|---|---|
| 1 | 2 |`;

    await sendReplyViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      tableText,
      { replyMode: "markdown", tableMode: "off" }
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.markdown.text).not.toContain("```");
  });

  it("logs debug messages when logger provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await sendReplyViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      "Hello",
      { logger }
    );

    expect(logger.debug).toHaveBeenCalled();
  });
});

describe("sendImageViaSessionWebhook", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends image via webhook", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendImageViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      "https://example.com/image.png"
    );

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("sendBySession");
    const body = JSON.parse(opts.body);
    expect(body.msgtype).toBe("image");
    expect(body.image.picURL).toBe("https://example.com/image.png");
  });

  it("sends accompanying text after image", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendImageViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      "https://example.com/image.png",
      { text: "Check this image" }
    );

    expect(result.ok).toBe(true);
    // Should have 2 calls: image + text
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns error when sessionWebhook is missing", async () => {
    const result = await sendImageViaSessionWebhook("", "https://example.com/image.png");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_sessionWebhook");
  });

  it("returns error on HTTP failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad request"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendImageViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      "https://example.com/image.png"
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("http_error");
  });
});

describe("sendActionCardViaSessionWebhook", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends single-button ActionCard via webhook", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendActionCardViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      {
        title: "Test Card",
        text: "Card body content",
        singleTitle: "View More",
        singleURL: "https://example.com",
      }
    );

    expect(result.ok).toBe(true);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("sendBySession");
    const body = JSON.parse(opts.body);
    expect(body.msgtype).toBe("actionCard");
    expect(body.actionCard.title).toBe("Test Card");
    expect(body.actionCard.singleTitle).toBe("View More");
  });

  it("sends multi-button ActionCard via webhook", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendActionCardViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      {
        title: "Choose Action",
        text: "Select an option below",
        btnOrientation: "1",
        buttons: [
          { title: "Option 1", actionURL: "https://example.com/1" },
          { title: "Option 2", actionURL: "https://example.com/2" },
        ],
      }
    );

    expect(result.ok).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.msgtype).toBe("actionCard");
    expect(body.actionCard.btns).toHaveLength(2);
    expect(body.actionCard.btns[0].title).toBe("Option 1");
    expect(body.actionCard.btnOrientation).toBe("1");
  });

  it("returns error when sessionWebhook is missing", async () => {
    const result = await sendActionCardViaSessionWebhook("", {
      title: "Test",
      text: "Test",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_sessionWebhook");
  });

  it("returns error on HTTP failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server error"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendActionCardViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      { title: "Test", text: "Test" }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("http_error");
    expect(result.status).toBe(500);
  });

  it("returns error on fetch exception", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendActionCardViaSessionWebhook(
      "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      { title: "Test", text: "Test" }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("fetch_error");
  });
});

describe("resolveResponsePrefix", () => {
  it("returns undefined for undefined template", () => {
    expect(resolveResponsePrefix(undefined, {})).toBeUndefined();
  });

  it("returns undefined for null template", () => {
    expect(resolveResponsePrefix(null as unknown as string, {})).toBeUndefined();
  });

  it("returns static template unchanged", () => {
    expect(resolveResponsePrefix("[Bot]", {})).toBe("[Bot]");
  });

  it("replaces {model} variable", () => {
    expect(resolveResponsePrefix("[{model}]", { model: "gpt-4" })).toBe("[gpt-4]");
  });

  it("replaces {provider} variable", () => {
    expect(resolveResponsePrefix("[{provider}]", { provider: "openai" })).toBe("[openai]");
  });

  it("replaces {identity} variable", () => {
    expect(resolveResponsePrefix("[{identity}]", { identity: "assistant" })).toBe("[assistant]");
  });

  it("replaces multiple variables", () => {
    const result = resolveResponsePrefix(
      "[{provider}/{model}]",
      { model: "gpt-4", provider: "openai" }
    );
    expect(result).toBe("[openai/gpt-4]");
  });

  it("keeps unmatched variables as-is", () => {
    expect(resolveResponsePrefix("[{model}]", {})).toBe("[{model}]");
    expect(resolveResponsePrefix("[{unknown}]", { model: "gpt-4" })).toBe("[{unknown}]");
  });

  it("is case insensitive for variable names", () => {
    expect(resolveResponsePrefix("[{MODEL}]", { model: "gpt-4" })).toBe("[gpt-4]");
    expect(resolveResponsePrefix("[{Model}]", { model: "gpt-4" })).toBe("[gpt-4]");
  });

  it("handles empty context", () => {
    expect(resolveResponsePrefix("Static prefix", {})).toBe("Static prefix");
  });
});
