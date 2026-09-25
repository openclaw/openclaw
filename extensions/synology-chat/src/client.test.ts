// Synology Chat tests cover client plugin behavior.
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import type { SynologyHostedMediaUrl } from "./outbound-media.js";

// Mock http and https modules before importing the client
vi.mock("node:https", async () => {
  const actual = await vi.importActual<typeof import("node:https")>("node:https");
  const httpsRequest = vi.fn();
  const httpsGet = vi.fn();
  const httpsModule = { ...actual, request: httpsRequest, get: httpsGet };
  return { ...actual, default: httpsModule, request: httpsRequest, get: httpsGet };
});

vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof import("node:http")>("node:http");
  const httpRequest = vi.fn();
  const httpGet = vi.fn();
  const httpModule = { ...actual, request: httpRequest, get: httpGet };
  return { ...actual, default: httpModule, request: httpRequest, get: httpGet };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  formatErrorMessage: coerceErrorMessage,
}));

const https = await import("node:https");
let fakeNowMs = 1_700_000_000_000;
let sendMessage: typeof import("./client.js").sendMessage;
let sendHostedFileUrl: typeof import("./client.js").sendHostedFileUrl;
let resolveLegacyWebhookNameToChatUserId: typeof import("./client.js").resolveLegacyWebhookNameToChatUserId;

type RequestCallback = (res: IncomingMessage) => void;
type MockRequestHandler = (
  url: string | URL,
  options: RequestOptions,
  callback?: RequestCallback,
) => ClientRequest;
type MockHttpCall = [
  string | URL,
  RequestOptions & { rejectUnauthorized?: boolean },
  RequestCallback?,
];
type MockResponse = IncomingMessage & PassThrough;

function firstHttpsRequestCall(label = "Synology Chat HTTPS request"): MockHttpCall {
  const call = vi.mocked(https.request).mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call as MockHttpCall;
}

function firstHttpsGetCall(label = "Synology Chat HTTPS get"): MockHttpCall {
  const call = vi.mocked(https.get).mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call as MockHttpCall;
}

function createMockResponseEmitter(statusCode: number): MockResponse {
  const res = new PassThrough() as PassThrough & Partial<IncomingMessage>;
  res.statusCode = statusCode;
  return res as unknown as MockResponse;
}

function createMockRequestEmitter(): ClientRequest {
  const req = new EventEmitter() as Partial<ClientRequest>;
  req.write = vi.fn() as ClientRequest["write"];
  req.end = vi.fn() as ClientRequest["end"];
  req.destroy = vi.fn() as ClientRequest["destroy"];
  return req as unknown as ClientRequest;
}

async function settleTimers<T>(promise: Promise<T>): Promise<T> {
  await Promise.resolve();
  await vi.runAllTimersAsync();
  return promise;
}

function mockResponse(statusCode: number, body: string) {
  const httpsRequest = vi.mocked(https.request);
  httpsRequest.mockImplementation(((...args) => {
    const callback = args[2];
    const res = createMockResponseEmitter(statusCode);
    process.nextTick(() => {
      callback?.(res);
      res.end(body);
    });
    return createMockRequestEmitter();
  }) as MockRequestHandler);
}

function mockSuccessResponse() {
  mockResponse(200, '{"success":true}');
}

function mockFailureResponse(statusCode = 500) {
  mockResponse(statusCode, "error");
}

function mockRequestErrorOnce(error: Error) {
  vi.mocked(https.request).mockImplementationOnce((() => {
    const req = createMockRequestEmitter();
    process.nextTick(() => req.emit("error", error));
    return req;
  }) as MockRequestHandler);
}

function installFakeTimerHarness() {
  beforeAll(async () => {
    ({ sendMessage, sendHostedFileUrl, resolveLegacyWebhookNameToChatUserId } =
      await import("./client.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeNowMs += 10_000;
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

function hostedUrl(value: string): SynologyHostedMediaUrl {
  return value as SynologyHostedMediaUrl;
}

const incomingUrl = "https://nas.example.com/incoming";
const hostedFileUrl = hostedUrl(
  "https://gateway.example.com/webhook?__openclaw_synology_media_token_a=t",
);

const tlsVerificationDefaultCases: Array<{ name: string; invoke: () => Promise<unknown> }> = [
  {
    name: "sendMessage",
    invoke: () => sendMessage("https://nas.example.com/incoming", "Hello"),
  },
  {
    name: "sendHostedFileUrl",
    invoke: () => sendHostedFileUrl(incomingUrl, hostedFileUrl),
  },
];

describe("Synology Chat TLS verification defaults", () => {
  installFakeTimerHarness();

  it.each(tlsVerificationDefaultCases)("$name verifies TLS by default", async ({ invoke }) => {
    mockSuccessResponse();
    await settleTimers(invoke());
    const firstCall = firstHttpsRequestCall();
    expect(firstCall[1]?.rejectUnauthorized).toBe(true);
  });
});

describe("sendMessage", () => {
  installFakeTimerHarness();

  it("returns true on successful send", async () => {
    mockSuccessResponse();
    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));
    expect(result).toBe(true);
  });

  it("returns false on server error without replaying", async () => {
    mockFailureResponse(500);
    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));
    expect(result).toBe(false);
    expect(vi.mocked(https.request)).toHaveBeenCalledOnce();
  });

  it("does not replay a mixed aggregate with an ambiguous transport leaf", async () => {
    const mixedError = Object.assign(
      new AggregateError([
        Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("connection reset after write"), { code: "ECONNRESET" }),
      ]),
      { code: "ECONNREFUSED" },
    );
    mockRequestErrorOnce(mixedError);

    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));

    expect(result).toBe(false);
    expect(vi.mocked(https.request)).toHaveBeenCalledOnce();
  });

  it("retries when every aggregate transport leaf is pre-connect", async () => {
    mockSuccessResponse();
    const aggregateError = Object.assign(
      new AggregateError([
        Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("host not found"), { code: "ENOTFOUND" }),
      ]),
      { code: "ECONNREFUSED" },
    );
    mockRequestErrorOnce(new TypeError("fetch failed", { cause: aggregateError }));

    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));

    expect(result).toBe(true);
    expect(vi.mocked(https.request)).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "Synology error envelope", body: { success: false, error: { code: 105 } } },
    { name: "unrelated malformed response fields", body: { success: false, data: null } },
  ])("does not replay an HTTP-successful webhook rejection ($name)", async ({ body }) => {
    mockResponse(200, JSON.stringify(body));

    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));

    expect(result).toBe(false);
    expect(vi.mocked(https.request)).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "missing success", body: "{}" },
    { name: "null response", body: "null" },
    { name: "empty response", body: "" },
    { name: "malformed JSON", body: '{"success":false' },
    { name: "plain text", body: "ok" },
    { name: "JSON string", body: '"ok"' },
    { name: "JSON number", body: "0" },
    { name: "JSON boolean", body: "false" },
    { name: "JSON array", body: "[]" },
    { name: "null success", body: '{"success":null}' },
    { name: "string success", body: '{"success":"false"}' },
    { name: "numeric success", body: '{"success":0}' },
    {
      name: "oversized rejection envelope",
      body: JSON.stringify({ success: false, padding: "x".repeat(1 * 1024 * 1024) }),
    },
  ])("preserves HTTP-successful webhook responses with $name", async ({ body }) => {
    mockResponse(200, body);

    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));

    expect(result).toBe(true);
    expect(vi.mocked(https.request)).toHaveBeenCalledTimes(1);
  });

  it.each([
    { userId: 42, expectedPayload: { text: "Hello", user_ids: [42] } },
    { userId: "42abc", expectedPayload: { text: "Hello" } },
    { userId: "+042", expectedPayload: { text: "Hello", user_ids: [42] } },
  ])("sends the expected recipient payload for $userId", async ({ userId, expectedPayload }) => {
    mockSuccessResponse();
    await settleTimers(sendMessage(incomingUrl, "Hello", userId));
    expect(firstHttpsRequestCall()[0]).toBe(incomingUrl);

    const request = vi.mocked(https.request).mock.results[0]?.value as ClientRequest | undefined;
    if (!request) {
      throw new Error("expected Synology Chat webhook request");
    }
    const body = vi.mocked(request["write"]).mock.calls[0]?.[0];
    if (typeof body !== "string") {
      throw new Error("expected Synology Chat webhook body");
    }
    const payload = JSON.parse(decodeURIComponent(body.replace(/^payload=/, ""))) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual(expectedPayload);
  });

  it("only disables TLS verification when explicitly requested", async () => {
    mockSuccessResponse();
    await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello", undefined, true));
    const firstCall = firstHttpsRequestCall();
    expect(firstCall[1]?.rejectUnauthorized).toBe(false);
  });
});

describe("sendHostedFileUrl", () => {
  installFakeTimerHarness();

  it.each([
    { name: "success", statusCode: 200, body: '{"success":true}', expectedStatus: "accepted" },
    { name: "server failure", statusCode: 500, body: "error", expectedStatus: "indeterminate" },
    { name: "client failure", statusCode: 400, body: "error", expectedStatus: "rejected" },
    {
      name: "HTTP-successful webhook rejection",
      statusCode: 200,
      body: '{"success":false,"error":{"code":105}}',
      expectedStatus: "rejected",
    },
  ])(
    "returns $expectedStatus without replaying $name",
    async ({ statusCode, body, expectedStatus }) => {
      mockResponse(statusCode, body);
      const result = await settleTimers(sendHostedFileUrl(incomingUrl, hostedFileUrl));
      expect(result).toEqual({ status: expectedStatus });
      expect(vi.mocked(https.request)).toHaveBeenCalledOnce();
    },
  );

  it("returns indeterminate when the request outcome is lost", async () => {
    vi.mocked(https.request).mockImplementation((() => {
      const req = createMockRequestEmitter();
      process.nextTick(() => req.emit("error", new Error("connection reset")));
      return req;
    }) as MockRequestHandler);

    const result = await settleTimers(sendHostedFileUrl(incomingUrl, hostedFileUrl));

    expect(result).toEqual({ status: "indeterminate" });
  });

  it("returns not-dispatched when the transport proves it never connected", async () => {
    mockRequestErrorOnce(Object.assign(new Error("host not found"), { code: "ENOTFOUND" }));

    const result = await settleTimers(sendHostedFileUrl(incomingUrl, hostedFileUrl));

    expect(result).toEqual({ status: "not-dispatched" });
  });

  it("returns not-dispatched when request construction fails synchronously", async () => {
    vi.mocked(https.request).mockImplementationOnce(() => {
      throw new Error("request construction failed");
    });

    const result = await settleTimers(sendHostedFileUrl(incomingUrl, hostedFileUrl));

    expect(result).toEqual({ status: "not-dispatched" });
  });

  it("returns not-dispatched when the incoming webhook URL is malformed", async () => {
    const result = await settleTimers(sendHostedFileUrl("not-a-url", hostedFileUrl));

    expect(result).toEqual({ status: "not-dispatched" });
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();
  });

  it("respects the shared send interval before posting a file URL", async () => {
    mockSuccessResponse();
    await settleTimers(sendMessage("https://nas.example.com/incoming", "hello"));
    vi.mocked(https.request).mockClear();

    const promise = sendHostedFileUrl(
      "https://nas.example.com/incoming",
      hostedUrl("https://gateway.example.com/webhook?__openclaw_synology_media_token_a=t"),
    );
    await Promise.resolve();
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(vi.mocked(https.request)).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "malformed", fileUrl: "not-a-url" },
    { name: "non-HTTPS", fileUrl: "http://example.com/file" },
    { name: "username-only", fileUrl: "https://fixture-user@gateway.example.com/webhook" },
    { name: "password-only", fileUrl: "https://:fixture-password@gateway.example.com/webhook" },
    { name: "fragment-only", fileUrl: "https://gateway.example.com/webhook#fragment" },
  ])("rejects $name hosted URLs before making a request", async ({ fileUrl }) => {
    const result = await settleTimers(sendHostedFileUrl(incomingUrl, hostedUrl(fileUrl)));
    expect(result).toEqual({ status: "not-dispatched" });
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();
  });
});

// Helper to mock the user_list API response for fetchChatUsers / resolveLegacyWebhookNameToChatUserId
function mockUserListResponse(users: Array<Record<string, unknown>>) {
  mockUserListResponseImpl(users, false);
}

function mockUserListResponseOnce(users: Array<Record<string, unknown>>) {
  mockUserListResponseImpl(users, true);
}

function mockUserListResponseImpl(users: Array<Record<string, unknown>>, once: boolean) {
  const httpsGet = vi.mocked(https.get);
  const impl: MockRequestHandler = (_url, _opts, callback) => {
    const res = createMockResponseEmitter(200);
    process.nextTick(() => {
      callback?.(res);
      res.end(JSON.stringify({ success: true, data: { users } }));
    });
    return createMockRequestEmitter();
  };
  if (once) {
    httpsGet.mockImplementationOnce(impl);
    return;
  }
  httpsGet.mockImplementation(impl);
}

describe("resolveLegacyWebhookNameToChatUserId", () => {
  const baseUrl =
    "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22";
  const baseUrl2 =
    "https://nas2.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test-2%22";

  beforeAll(async () => {
    ({ resolveLegacyWebhookNameToChatUserId } = await import("./client.js"));
  });

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

  it.each([
    {
      name: "nickname (webhook username = Chat nickname)",
      users: [
        { user_id: 4, username: "jmn67", nickname: "jmn" },
        { user_id: 7, username: "she67", nickname: "sarah" },
      ],
      mutableWebhookUsername: "jmn",
      expectedUserId: 4,
    },
    {
      name: "username when nickname does not match",
      users: [
        { user_id: 4, username: "jmn67", nickname: "" },
        { user_id: 7, username: "she67", nickname: "sarah" },
      ],
      mutableWebhookUsername: "jmn67",
      expectedUserId: 4,
    },
    {
      name: "case-insensitive nickname",
      users: [{ user_id: 4, username: "JMN67", nickname: "JMN" }],
      mutableWebhookUsername: "jmn",
      expectedUserId: 4,
    },
    {
      name: "unknown user",
      users: [{ user_id: 4, username: "jmn67", nickname: "jmn" }],
      mutableWebhookUsername: "unknown_user",
      expectedUserId: undefined,
    },
  ])("resolves $name", async ({ users, mutableWebhookUsername, expectedUserId }) => {
    mockUserListResponse(users);
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername,
    });
    expect(result).toBe(expectedUserId);
  });

  it("preserves UTF-8 when user_list splits a nickname across response chunks", async () => {
    const nickname = "猫";
    const responseBody = Buffer.from(
      JSON.stringify({
        success: true,
        data: { users: [{ user_id: 4, username: "jmn67", nickname }] },
      }),
      "utf8",
    );
    const nicknameOffset = responseBody.indexOf(Buffer.from(nickname, "utf8"));
    const splitAt = nicknameOffset + 1;
    vi.mocked(https.get).mockImplementation(((_url, _opts, callback) => {
      const res = createMockResponseEmitter(200);
      process.nextTick(() => {
        callback?.(res);
        res.write(responseBody.subarray(0, splitAt));
        res.end(responseBody.subarray(splitAt));
      });
      return createMockRequestEmitter();
    }) as MockRequestHandler);

    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: nickname,
    });

    expect(result).toBe(4);
  });

  it("uses method=user_list instead of method=chatbot in the API URL", async () => {
    mockUserListResponse([]);
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "anyone",
    });
    const call = firstHttpsGetCall("Synology Chat user_list request");
    expect(String(call[0])).toBe(baseUrl.replace("method=chatbot", "method=user_list"));
    expect(call[1]).toEqual({ rejectUnauthorized: true });
    expect(typeof call[2]).toBe("function");
  });

  it("keeps user cache scoped per incoming URL", async () => {
    mockUserListResponseOnce([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    mockUserListResponseOnce([{ user_id: 9, username: "jmn67", nickname: "jmn" }]);

    const result1 = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "jmn",
    });
    const result2 = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl2,
      mutableWebhookUsername: "jmn",
    });

    expect(result1).toBe(4);
    expect(result2).toBe(9);
    const httpsGet = vi.mocked(https.get);
    expect(httpsGet).toHaveBeenCalledTimes(2);
  });
});

describe("resolveLegacyWebhookNameToChatUserId user lookup", () => {
  installFakeTimerHarness();

  it("filters malformed user entries while keeping valid ones", async () => {
    const lookupUrl =
      "https://malformed-users.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2";
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "jmn" },
      { user_id: "bad", username: "broken" },
    ]);

    const userId = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: lookupUrl,
      mutableWebhookUsername: "jmn",
    });

    expect(userId).toBe(4);
    await expect(
      resolveLegacyWebhookNameToChatUserId({
        incomingUrl: lookupUrl,
        mutableWebhookUsername: "broken",
      }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(https.get)).toHaveBeenCalledOnce();
  });

  it("falls back when the user_list body exceeds the byte cap", async () => {
    const httpsGet = vi.mocked(https.get);
    const warns: string[] = [];
    // Single oversized Buffer: over 1 MiB cap without multi-write/destroy races.
    const oversized = Buffer.alloc(1 * 1024 * 1024 + 1, 0x78);
    const overflowUrl =
      "https://overflow-nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2";
    httpsGet.mockImplementation(((_url, _opts, callback) => {
      const res = createMockResponseEmitter(200);
      process.nextTick(() => {
        callback?.(res);
        res.end(oversized);
      });
      return createMockRequestEmitter();
    }) as MockRequestHandler);

    const userId = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: overflowUrl,
      mutableWebhookUsername: "anyone",
      log: {
        warn: (...args: unknown[]) => {
          warns.push(args.map(String).join(" "));
        },
      },
    });

    expect(userId).toBeUndefined();
    expect(warns.some((line) => line.includes("exceeded"))).toBe(true);
  });
});
