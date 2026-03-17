import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
const { sendMessage, sendFileUrl, fetchChatUsers, resolveChatUserId } = await import("./client.js");
const https = await import("node:https");
let fakeNowMs = 17e11;
async function settleTimers(promise) {
  await Promise.resolve();
  await vi.runAllTimersAsync();
  return promise;
}
function mockResponse(statusCode, body) {
  const httpsRequest = vi.mocked(https.request);
  httpsRequest.mockImplementation((_url, _opts, callback) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    process.nextTick(() => {
      callback(res);
      res.emit("data", Buffer.from(body));
      res.emit("end");
    });
    const req = new EventEmitter();
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
function installFakeTimerHarness() {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeNowMs += 1e4;
    vi.setSystemTime(fakeNowMs);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
describe("sendMessage", () => {
  installFakeTimerHarness();
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
describe("sendFileUrl", () => {
  installFakeTimerHarness();
  it("returns true on success", async () => {
    mockSuccessResponse();
    const result = await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png")
    );
    expect(result).toBe(true);
  });
  it("returns false on failure", async () => {
    mockFailureResponse(500);
    const result = await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png")
    );
    expect(result).toBe(false);
  });
});
function mockUserListResponse(users) {
  mockUserListResponseImpl(users, false);
}
function mockUserListResponseOnce(users) {
  mockUserListResponseImpl(users, true);
}
function mockUserListResponseImpl(users, once) {
  const httpsGet = vi.mocked(https.get);
  const impl = (_url, _opts, callback) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    process.nextTick(() => {
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify({ success: true, data: { users } })));
      res.emit("end");
    });
    const req = new EventEmitter();
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
  const baseUrl = "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22";
  const baseUrl2 = "https://nas2.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test-2%22";
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeNowMs += 10 * 60 * 1e3;
    vi.setSystemTime(fakeNowMs);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("resolves user by nickname (webhook username = Chat nickname)", async () => {
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "jmn" },
      { user_id: 7, username: "she67", nickname: "sarah" }
    ]);
    const result = await resolveChatUserId(baseUrl, "jmn");
    expect(result).toBe(4);
  });
  it("resolves user by username when nickname does not match", async () => {
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "" },
      { user_id: 7, username: "she67", nickname: "sarah" }
    ]);
    fakeNowMs += 10 * 60 * 1e3;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveChatUserId(baseUrl, "jmn67");
    expect(result).toBe(4);
  });
  it("is case-insensitive", async () => {
    mockUserListResponse([{ user_id: 4, username: "JMN67", nickname: "JMN" }]);
    fakeNowMs += 10 * 60 * 1e3;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveChatUserId(baseUrl, "jmn");
    expect(result).toBe(4);
  });
  it("returns undefined when user is not found", async () => {
    mockUserListResponse([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    fakeNowMs += 10 * 60 * 1e3;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveChatUserId(baseUrl, "unknown_user");
    expect(result).toBeUndefined();
  });
  it("uses method=user_list instead of method=chatbot in the API URL", async () => {
    mockUserListResponse([]);
    fakeNowMs += 10 * 60 * 1e3;
    vi.setSystemTime(fakeNowMs);
    await resolveChatUserId(baseUrl, "anyone");
    const httpsGet = vi.mocked(https.get);
    expect(httpsGet).toHaveBeenCalledWith(
      expect.stringContaining("method=user_list"),
      expect.any(Object),
      expect.any(Function)
    );
  });
  it("keeps user cache scoped per incoming URL", async () => {
    mockUserListResponseOnce([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    mockUserListResponseOnce([{ user_id: 9, username: "jmn67", nickname: "jmn" }]);
    const result1 = await resolveChatUserId(baseUrl, "jmn");
    const result2 = await resolveChatUserId(baseUrl2, "jmn");
    expect(result1).toBe(4);
    expect(result2).toBe(9);
    const httpsGet = vi.mocked(https.get);
    expect(httpsGet).toHaveBeenCalledTimes(2);
  });
});
