/**
 * Tests for proactive message sending API.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { parseTarget, sendProactiveMessage, sendBatchDirectMessage, sendImageMessage, sendActionCardMessage, sendFileMessage } from "./send-message.js";
import { clearAllTokens } from "./token-manager.js";
import { BASIC_ACCOUNT, MARKDOWN_ACCOUNT } from "../../test/fixtures/configs.js";

describe("parseTarget", () => {
  it("parses user: prefix", () => {
    expect(parseTarget("user:userId123")).toEqual({ type: "user", id: "userId123" });
  });

  it("parses group: prefix", () => {
    expect(parseTarget("group:cidXXX")).toEqual({ type: "group", id: "cidXXX" });
  });

  it("parses dingtalk:dm: session key format", () => {
    expect(parseTarget("dingtalk:dm:user001")).toEqual({ type: "user", id: "user001" });
  });

  it("parses dingtalk:group: session key format", () => {
    expect(parseTarget("dingtalk:group:cid123")).toEqual({ type: "group", id: "cid123" });
  });

  it("auto-detects group from cid prefix", () => {
    expect(parseTarget("cidXXXXXX")).toEqual({ type: "group", id: "cidXXXXXX" });
  });

  it("defaults to user for unknown format", () => {
    expect(parseTarget("someUserId")).toEqual({ type: "user", id: "someUserId" });
  });

  it("trims whitespace", () => {
    expect(parseTarget("  user:userId  ")).toEqual({ type: "user", id: "userId" });
  });
});

describe("sendProactiveMessage", () => {
  beforeEach(() => {
    // Clear token cache before each test
    clearAllTokens();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends direct message to user", async () => {
    const mockFetch = vi.fn()
      // Token request
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      // Message send request
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "query-123" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendProactiveMessage({
      account: BASIC_ACCOUNT,
      to: "user:testUser",
      text: "Hello!",
    });

    expect(result.ok).toBe(true);
    expect(result.processQueryKey).toBe("query-123");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify message API call
    const messageCall = mockFetch.mock.calls[1];
    expect(messageCall[0]).toContain("/robot/oToMessages/batchSend");
    const body = JSON.parse(messageCall[1].body);
    expect(body.userIds).toEqual(["testUser"]);
    expect(body.msgKey).toBe("sampleText");
  });

  it("sends group message", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "group-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendProactiveMessage({
      account: BASIC_ACCOUNT,
      to: "group:cidTest",
      text: "Group message",
    });

    expect(result.ok).toBe(true);
    const messageCall = mockFetch.mock.calls[1];
    expect(messageCall[0]).toContain("/robot/groupMessages/send");
    const body = JSON.parse(messageCall[1].body);
    expect(body.openConversationId).toBe("cidTest");
  });

  it("sends markdown message", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "md-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendProactiveMessage({
      account: MARKDOWN_ACCOUNT,
      to: "user:testUser",
      text: "# Markdown",
      replyMode: "markdown",
    });

    expect(result.ok).toBe(true);
	    const messageCall = mockFetch.mock.calls[1];
	    const body = JSON.parse(messageCall[1].body);
	    expect(body.msgKey).toBe("sampleMarkdown");
	    expect(JSON.parse(body.msgParam).title).toBe("OpenClaw");
	  });

  it("chunks long messages", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "chunk-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const longText = "A".repeat(4000);
    const result = await sendProactiveMessage({
      account: BASIC_ACCOUNT,
      to: "user:testUser",
      text: longText,
    });

    expect(result.ok).toBe(true);
    expect(result.chunks).toBeGreaterThan(1);
  });

  it("returns error when token fetch fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Invalid credentials"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendProactiveMessage({
      account: BASIC_ACCOUNT,
      to: "user:testUser",
      text: "Hello",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error when message send fails", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad request"),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendProactiveMessage({
      account: BASIC_ACCOUNT,
      to: "user:testUser",
      text: "Hello",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("400");
  });
});

describe("sendBatchDirectMessage", () => {
  beforeEach(() => {
    clearAllTokens();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends to multiple users", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          processQueryKey: "batch-query",
          invalidStaffIdList: ["invalid1"],
          flowControlledStaffIdList: ["flow1"],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendBatchDirectMessage({
      account: BASIC_ACCOUNT,
      userIds: ["user1", "user2", "user3"],
      text: "Batch message",
    });

    expect(result.ok).toBe(true);
    expect(result.invalidUserIds).toEqual(["invalid1"]);
    expect(result.flowControlledUserIds).toEqual(["flow1"]);
  });

  it("returns error for empty userIds", async () => {
    const result = await sendBatchDirectMessage({
      account: BASIC_ACCOUNT,
      userIds: [],
      text: "Message",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("No user IDs");
  });
});

describe("sendImageMessage", () => {
  beforeEach(() => {
    clearAllTokens();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends image to user", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "img-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendImageMessage({
      account: BASIC_ACCOUNT,
      to: "user:testUser",
      picUrl: "https://example.com/image.png",
    });

    expect(result.ok).toBe(true);
    expect(result.processQueryKey).toBe("img-query");

    const messageCall = mockFetch.mock.calls[1];
    expect(messageCall[0]).toContain("/robot/oToMessages/batchSend");
    const body = JSON.parse(messageCall[1].body);
    expect(body.msgKey).toBe("sampleImageMsg");
    expect(JSON.parse(body.msgParam).photoURL).toBe("https://example.com/image.png");
  });

  it("sends image to group", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "group-img-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendImageMessage({
      account: BASIC_ACCOUNT,
      to: "group:cidTest",
      picUrl: "https://example.com/photo.jpg",
    });

    expect(result.ok).toBe(true);
    const messageCall = mockFetch.mock.calls[1];
    expect(messageCall[0]).toContain("/robot/groupMessages/send");
  });

  it("sends accompanying text after image", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "img-query" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "text-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendImageMessage({
      account: BASIC_ACCOUNT,
      to: "user:testUser",
      picUrl: "https://example.com/image.png",
      text: "Here is the image",
    });

    expect(result.ok).toBe(true);
    // Should have 3 calls: token + image + text
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe("sendActionCardMessage", () => {
  beforeEach(() => {
    clearAllTokens();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends single-button ActionCard", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "card-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendActionCardMessage({
      account: BASIC_ACCOUNT,
      to: "user:testUser",
      actionCard: {
        title: "Test Card",
        text: "Card content here",
        singleTitle: "Open",
        singleURL: "https://example.com",
      },
    });

    expect(result.ok).toBe(true);
    const messageCall = mockFetch.mock.calls[1];
    const body = JSON.parse(messageCall[1].body);
    expect(body.msgKey).toBe("sampleActionCard");
    const msgParam = JSON.parse(body.msgParam);
    expect(msgParam.title).toBe("Test Card");
    expect(msgParam.singleTitle).toBe("Open");
  });

  it("sends multi-button ActionCard", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "multi-card-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendActionCardMessage({
      account: BASIC_ACCOUNT,
      to: "group:cidTest",
      actionCard: {
        title: "Choose Option",
        text: "Please select one",
        buttons: [
          { title: "Option A", actionURL: "https://example.com/a" },
          { title: "Option B", actionURL: "https://example.com/b" },
          { title: "Option C", actionURL: "https://example.com/c" },
        ],
      },
    });

    expect(result.ok).toBe(true);
    const messageCall = mockFetch.mock.calls[1];
    const body = JSON.parse(messageCall[1].body);
    expect(body.msgKey).toBe("sampleActionCard3");
    const msgParam = JSON.parse(body.msgParam);
    expect(msgParam.actionTitle1).toBe("Option A");
    expect(msgParam.actionUrl1).toBe("https://example.com/a");
    expect(msgParam.actionTitle3).toBe("Option C");
  });

  it("limits buttons to 5", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "max-card-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendActionCardMessage({
      account: BASIC_ACCOUNT,
      to: "user:testUser",
      actionCard: {
        title: "Many Options",
        text: "Choose wisely",
        buttons: [
          { title: "1", actionURL: "https://example.com/1" },
          { title: "2", actionURL: "https://example.com/2" },
          { title: "3", actionURL: "https://example.com/3" },
          { title: "4", actionURL: "https://example.com/4" },
          { title: "5", actionURL: "https://example.com/5" },
          { title: "6", actionURL: "https://example.com/6" }, // Should be ignored
        ],
      },
    });

    expect(result.ok).toBe(true);
    const messageCall = mockFetch.mock.calls[1];
    const body = JSON.parse(messageCall[1].body);
    expect(body.msgKey).toBe("sampleActionCard5");
    const msgParam = JSON.parse(body.msgParam);
    expect(msgParam.actionTitle5).toBe("5");
    expect(msgParam.actionTitle6).toBeUndefined();
  });
});

describe("sendFileMessage", () => {
  beforeEach(() => {
    clearAllTokens();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends file to user", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "file-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendFileMessage({
      account: BASIC_ACCOUNT,
      to: "user:testUser",
      mediaId: "media-123",
      fileName: "document.pdf",
      fileType: "pdf",
    });

    expect(result.ok).toBe(true);
    expect(result.processQueryKey).toBe("file-query");

    const messageCall = mockFetch.mock.calls[1];
    expect(messageCall[0]).toContain("/robot/oToMessages/batchSend");
    const body = JSON.parse(messageCall[1].body);
    expect(body.msgKey).toBe("sampleFile");
    const msgParam = JSON.parse(body.msgParam);
    expect(msgParam.mediaId).toBe("media-123");
    expect(msgParam.fileName).toBe("document.pdf");
  });

  it("sends file to group", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ processQueryKey: "group-file-query" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendFileMessage({
      account: BASIC_ACCOUNT,
      to: "group:cidTest",
      mediaId: "media-456",
      fileName: "report.xlsx",
    });

    expect(result.ok).toBe(true);
    const messageCall = mockFetch.mock.calls[1];
    expect(messageCall[0]).toContain("/robot/groupMessages/send");
  });
});
