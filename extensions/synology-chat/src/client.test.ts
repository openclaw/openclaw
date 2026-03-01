import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock http and https modules before importing the client
vi.mock("node:https", () => {
  const mockRequest = vi.fn();
  return { default: { request: mockRequest }, request: mockRequest };
});

vi.mock("node:http", () => {
  const mockRequest = vi.fn();
  return { default: { request: mockRequest }, request: mockRequest };
});

// Import after mocks are set up
const { sendMessage, sendFileUrl } = await import("./client.js");
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
