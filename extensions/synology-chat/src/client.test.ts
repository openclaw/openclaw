import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock http and https modules before importing the client
vi.mock("node:https", () => {
  const mockRequest = vi.fn();
  const mockGet = vi.fn();
  return { default: { request: mockRequest, get: mockGet }, request: mockRequest, get: mockGet };
});

vi.mock("node:http", () => {
  const mockRequest = vi.fn();
  const mockGet = vi.fn();
  return { default: { request: mockRequest, get: mockGet }, request: mockRequest, get: mockGet };
});

// Import after mocks are set up
const {
  sendMessage,
  sendFileUrl,
  fetchChatUsers,
  resolveChatUserId,
  splitTextForSynology,
  SYNOLOGY_CHUNK_LIMIT,
} = await import("./client.js");
const https = await import("node:https");
let fakeNowMs = 1_700_000_000_000;

async function settleTimers<T>(promise: Promise<T>): Promise<T> {
  await Promise.resolve();
  await vi.runAllTimersAsync();
  return promise;
}

function mockResponse(statusCode: number, body: string) {
  const httpsRequest = vi.mocked(https.request);
  httpsRequest.mockImplementation((_url: any, _opts: any, callback: any) => {
    const res = new EventEmitter() as any;
    res.statusCode = statusCode;
    process.nextTick(() => {
      callback(res);
      res.emit("data", Buffer.from(body));
      res.emit("end");
    });
    const req = new EventEmitter() as any;
    req.write = vi.fn();
    req.end = vi.fn();
    req.destroy = vi.fn();
    return req;
  });
}

function mockSuccessResponse() {
  mockResponse(200, '{"success":true}');
}

function mockFailureResponse(statusCode = 500) {
  mockResponse(statusCode, "error");
}

describe("sendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeNowMs += 10_000;
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true on successful send", async () => {
    mockSuccessResponse();
    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));
    expect(result).toBe(true);
  });

  it("returns false on server error after retries", async () => {
    mockFailureResponse(500);
    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));
    expect(result).toBe(false);
  });

  it("includes user_ids when userId is numeric", async () => {
    mockSuccessResponse();
    await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello", 42));
    const httpsRequest = vi.mocked(https.request);
    expect(httpsRequest).toHaveBeenCalled();
    const callArgs = httpsRequest.mock.calls[0];
    expect(callArgs[0]).toBe("https://nas.example.com/incoming");
  });
});

describe("splitTextForSynology", () => {
  it("returns single chunk for short text", () => {
    const result = splitTextForSynology("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("returns single chunk for text at exactly the limit", () => {
    const text = "x".repeat(SYNOLOGY_CHUNK_LIMIT);
    const result = splitTextForSynology(text);
    expect(result).toEqual([text]);
  });

  it("splits long text into multiple chunks", () => {
    const text = "word ".repeat(500); // ~2500 chars
    const chunks = splitTextForSynology(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Rejoined text should equal original
    expect(chunks.join("")).toBe(text);
  });

  it("prefers splitting at newlines", () => {
    const line = "a".repeat(1000);
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitTextForSynology(text);
    // First chunk should end right after the first newline
    expect(chunks[0]).toBe(`${line}\n`);
  });

  it("falls back to splitting at spaces", () => {
    // No newlines, but has spaces
    const words = "abcdefghij ".repeat(200); // ~2200 chars, no newlines
    const chunks = splitTextForSynology(words);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(words);
    // First chunk should end at a space boundary
    expect(chunks[0].endsWith(" ")).toBe(true);
  });

  it("hard-cuts when no whitespace is available", () => {
    const text = "x".repeat(4000); // No spaces or newlines
    const chunks = splitTextForSynology(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    expect(chunks[0].length).toBe(SYNOLOGY_CHUNK_LIMIT);
  });

  it("respects custom limit parameter", () => {
    const text = "a".repeat(100);
    const chunks = splitTextForSynology(text, 30);
    expect(chunks.length).toBe(4); // 30 + 30 + 30 + 10
    expect(chunks.join("")).toBe(text);
  });
});

describe("sendMessage chunking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeNowMs += 10_000;
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends multiple requests for long text", async () => {
    mockSuccessResponse();
    const longText = "word ".repeat(1000); // ~5000 chars
    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", longText));
    expect(result).toBe(true);
    const httpsRequest = vi.mocked(https.request);
    expect(httpsRequest.mock.calls.length).toBeGreaterThan(1);
  });

  it("sends single request for short text", async () => {
    mockSuccessResponse();
    const result = await settleTimers(
      sendMessage("https://nas.example.com/incoming", "Short message"),
    );
    expect(result).toBe(true);
    const httpsRequest = vi.mocked(https.request);
    // May have retries but only 1 unique message payload
    expect(httpsRequest.mock.calls.length).toBe(1);
  });

  it("only includes user_ids in the first chunk to avoid duplicate notifications", async () => {
    mockSuccessResponse();
    const longText = "word ".repeat(1000); // ~5000 chars, will produce multiple chunks
    await settleTimers(sendMessage("https://nas.example.com/incoming", longText, 42));
    const httpsRequest = vi.mocked(https.request);
    const calls = httpsRequest.mock.calls;
    expect(calls.length).toBeGreaterThan(1);

    // Extract payload bodies from each call
    for (let i = 0; i < calls.length; i++) {
      // The body is written via req.write — get it from the mock
      const req = httpsRequest.mock.results[i].value;
      const writeCall = req.write.mock.calls[0][0] as string;
      const payloadStr = decodeURIComponent(writeCall.replace("payload=", ""));
      const payload = JSON.parse(payloadStr);

      if (i === 0) {
        expect(payload.user_ids).toEqual([42]);
      } else {
        expect(payload.user_ids).toBeUndefined();
      }
    }
  });

  it("returns false if any chunk fails", async () => {
    const httpsRequest = vi.mocked(https.request);
    let callCount = 0;
    httpsRequest.mockImplementation((_url: any, _opts: any, callback: any) => {
      callCount++;
      const res = new EventEmitter() as any;
      // First chunk succeeds, second fails
      res.statusCode = callCount <= 1 ? 200 : 500;
      process.nextTick(() => {
        callback(res);
        res.emit("data", Buffer.from("ok"));
        res.emit("end");
      });
      const req = new EventEmitter() as any;
      req.write = vi.fn();
      req.end = vi.fn();
      req.destroy = vi.fn();
      return req;
    });

    const longText = "word ".repeat(1000);
    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", longText));
    expect(result).toBe(false);
  });
});

describe("sendFileUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeNowMs += 10_000;
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true on success", async () => {
    mockSuccessResponse();
    const result = await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png"),
    );
    expect(result).toBe(true);
  });

  it("returns false on failure", async () => {
    mockFailureResponse(500);
    const result = await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png"),
    );
    expect(result).toBe(false);
  });
});

// Helper to mock the user_list API response for fetchChatUsers / resolveChatUserId
function mockUserListResponse(
  users: Array<{ user_id: number; username: string; nickname: string }>,
) {
  mockUserListResponseImpl(users, false);
}

function mockUserListResponseOnce(
  users: Array<{ user_id: number; username: string; nickname: string }>,
) {
  mockUserListResponseImpl(users, true);
}

function mockUserListResponseImpl(
  users: Array<{ user_id: number; username: string; nickname: string }>,
  once: boolean,
) {
  const httpsGet = vi.mocked((https as any).get);
  const impl = (_url: any, _opts: any, callback: any) => {
    const res = new EventEmitter() as any;
    res.statusCode = 200;
    process.nextTick(() => {
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify({ success: true, data: { users } })));
      res.emit("end");
    });
    const req = new EventEmitter() as any;
    req.destroy = vi.fn();
    return req;
  };
  if (once) {
    httpsGet.mockImplementationOnce(impl);
    return;
  }
  httpsGet.mockImplementation(impl);
}

describe("resolveChatUserId", () => {
  const baseUrl =
    "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22";
  const baseUrl2 =
    "https://nas2.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test-2%22";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Advance time to invalidate any cached user list from previous tests
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves user by nickname (webhook username = Chat nickname)", async () => {
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "jmn" },
      { user_id: 7, username: "she67", nickname: "sarah" },
    ]);
    const result = await resolveChatUserId(baseUrl, "jmn");
    expect(result).toBe(4);
  });

  it("resolves user by username when nickname does not match", async () => {
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "" },
      { user_id: 7, username: "she67", nickname: "sarah" },
    ]);
    // Advance time to invalidate cache
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveChatUserId(baseUrl, "jmn67");
    expect(result).toBe(4);
  });

  it("is case-insensitive", async () => {
    mockUserListResponse([{ user_id: 4, username: "JMN67", nickname: "JMN" }]);
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveChatUserId(baseUrl, "jmn");
    expect(result).toBe(4);
  });

  it("returns undefined when user is not found", async () => {
    mockUserListResponse([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveChatUserId(baseUrl, "unknown_user");
    expect(result).toBeUndefined();
  });

  it("uses method=user_list instead of method=chatbot in the API URL", async () => {
    mockUserListResponse([]);
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    await resolveChatUserId(baseUrl, "anyone");
    const httpsGet = vi.mocked((https as any).get);
    expect(httpsGet).toHaveBeenCalledWith(
      expect.stringContaining("method=user_list"),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("keeps user cache scoped per incoming URL", async () => {
    mockUserListResponseOnce([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    mockUserListResponseOnce([{ user_id: 9, username: "jmn67", nickname: "jmn" }]);

    const result1 = await resolveChatUserId(baseUrl, "jmn");
    const result2 = await resolveChatUserId(baseUrl2, "jmn");

    expect(result1).toBe(4);
    expect(result2).toBe(9);
    const httpsGet = vi.mocked((https as any).get);
    expect(httpsGet).toHaveBeenCalledTimes(2);
  });
});
