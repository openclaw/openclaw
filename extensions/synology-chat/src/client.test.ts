// Synology Chat tests cover client plugin behavior.
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveLegacyWebhookNameToChatUserId, sendHostedFileUrl, sendMessage } from "./client.js";
import type { SynologyHostedMediaUrl } from "./outbound-media.js";

// Vitest hoists transport mocks before the static client import.
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

function firstHttpsRequestPayload(): unknown {
  const request = vi.mocked(https.request).mock.results[0]?.value;
  if (!request) {
    throw new Error("expected Synology Chat webhook request");
  }
  const body = vi.mocked(request.write).mock.calls[0]?.[0];
  if (typeof body !== "string") {
    throw new Error("expected Synology Chat webhook body");
  }
  return JSON.parse(decodeURIComponent(body.replace(/^payload=/, "")));
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

function responseHandler(statusCode: number, chunks: Array<string | Buffer>): MockRequestHandler {
  return (_url, _options, callback) => {
    const res = createMockResponseEmitter(statusCode);
    process.nextTick(() => {
      callback?.(res);
      for (const chunk of chunks) {
        res.write(chunk);
      }
      res.end();
    });
    return createMockRequestEmitter();
  };
}

function mockResponse(statusCode: number, body: string) {
  vi.mocked(https.request).mockImplementation(responseHandler(statusCode, [body]));
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

function installFakeTimerHarness(advanceMs = 10_000) {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeNowMs += advanceMs;
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

function hostedUrl(value: string): SynologyHostedMediaUrl {
  return value as SynologyHostedMediaUrl;
}

const hostedCapabilityUrl = hostedUrl(
  "https://gateway.example.com/webhook?__openclaw_synology_media_token_a=t",
);

const webhookUrl = "https://nas.example.com/incoming";
const sendText = (text = "Hello", userId?: string, insecure = false) =>
  settleTimers(sendMessage(webhookUrl, text, userId, insecure));
const sendFile = (url = webhookUrl) => settleTimers(sendHostedFileUrl(url, hostedCapabilityUrl));

const tlsVerificationDefaultCases: Array<{ name: string; invoke: () => Promise<unknown> }> = [
  {
    name: "sendMessage",
    invoke: () => sendMessage("https://nas.example.com/incoming", "Hello"),
  },
  {
    name: "sendHostedFileUrl",
    invoke: () => sendHostedFileUrl("https://nas.example.com/incoming", hostedCapabilityUrl),
  },
];

describe("Synology Chat TLS verification defaults", () => {
  installFakeTimerHarness();

  it.each(
    tlsVerificationDefaultCases.flatMap(({ name, invoke }) => [
      { name, invoke, refused: false },
      { name, invoke, refused: true },
    ]),
  )(
    "prepares $name webhook POST before handoff (refused=$refused)",
    async ({ name, invoke, refused }) => {
      const preparing = createDeferred<void>();
      const prepared = createDeferred<void>();
      const handedOff = createDeferred<void>();
      const acknowledgment = createDeferred<void>();
      const refusal = new Error("Synology message authority ended");
      const authority = fetchRuntime.captureEffectAuthority();
      const capture = vi.spyOn(fetchRuntime, "captureEffectAuthority").mockReturnValue({
        ...authority,
        async initiate(effect) {
          preparing.resolve();
          await prepared.promise;
          if (refused) {
            throw refusal;
          }
          return authority.initiate(effect);
        },
      });
      vi.mocked(https.request).mockImplementation(((...args) => {
        handedOff.resolve();
        const res = createMockResponseEmitter(200);
        void acknowledgment.promise.then(() => {
          args[2]?.(res);
          res.end('{"success":true}');
        });
        return createMockRequestEmitter();
      }) as MockRequestHandler);
      const sending = invoke();
      try {
        await Promise.race([
          preparing.promise,
          handedOff.promise.then(() => {
            throw new Error("webhook POST bypassed preparation");
          }),
        ]);
        expect(https.request).not.toHaveBeenCalled();
        prepared.resolve();
        if (!refused) {
          await handedOff.promise;
          acknowledgment.resolve();
        }
        if (refused) {
          await expect(sending).rejects.toBe(refusal);
        } else {
          expect(await sending).toEqual(
            name === "sendMessage" ? { messageIds: [] } : { status: "accepted" },
          );
        }
        expect(https.request).toHaveBeenCalledTimes(refused ? 0 : 1);
        if (!refused) {
          expect(firstHttpsRequestCall()[1]?.rejectUnauthorized).toBe(true);
        }
      } finally {
        prepared.resolve();
        acknowledgment.resolve();
        await sending.catch(() => {});
        capture.mockRestore();
      }
    },
  );
});

describe("sendMessage", () => {
  installFakeTimerHarness();

  it.each([
    { recipient: "123456", postId: 25769804017, ids: ["25769804017"] },
    { recipient: "123456", postId: "18446744073709551615", ids: ["18446744073709551615"] },
    { recipient: "999999", postId: 25769804017, ids: [] },
    { recipient: "123456", postId: 9007199254740992, ids: [] },
    { recipient: "123456", postId: 0, ids: [] },
    { recipient: "123456", postId: "invalid", ids: [] },
  ])(
    "keeps only usable post IDs for the requested recipient: $recipient/$postId",
    async ({ recipient, postId, ids }) => {
      mockResponse(
        200,
        JSON.stringify({
          success: true,
          data: { succ: { user_id_post_map: { [recipient]: postId } } },
        }),
      );

      await expect(sendText("Hello", "123456")).resolves.toEqual({ messageIds: ids });
    },
  );

  it("preserves explicit rejection when identity metadata is malformed", async () => {
    mockResponse(200, JSON.stringify({ success: false, data: { succ: null } }));

    await expect(sendText("Hello", "123456")).resolves.toBe(false);
  });

  it("preserves acknowledged chunks when a later chunk is rejected", async () => {
    let requests = 0;
    vi.mocked(https.request).mockImplementation(((_url, _options, callback) => {
      requests += 1;
      const lastChunk = requests === 3;
      process.nextTick(() => {
        const res = createMockResponseEmitter(200);
        callback?.(res);
        res.end(JSON.stringify({ success: !lastChunk }));
      });
      return createMockRequestEmitter();
    }) as MockRequestHandler);
    const sending = sendMessage("https://nas.example.com/incoming", "a".repeat(4001), "42");
    const outcome = await settleTimers(
      sending.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      ),
    );
    expect(outcome).toMatchObject({
      error: {
        code: "CHANNEL_PARTIAL_DELIVERY",
        message: "Failed to send message to Synology Chat (rejected)",
        deliveryResult: { visibleReplySent: true, content: "a".repeat(4000) },
      },
    });
    expect(https.request).toHaveBeenCalledTimes(3);
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

    const result = await sendText();

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

    const result = await sendText();

    expect(result).toEqual({ messageIds: [] });
    expect(vi.mocked(https.request)).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "oversized rejection envelope",
      body: JSON.stringify({ success: false, padding: "x".repeat(1 * 1024 * 1024) }),
    },
  ])("preserves HTTP-successful webhook responses with $name", async ({ body }) => {
    mockResponse(200, body);

    const result = await sendText();

    expect(result).toEqual({ messageIds: [] });
    expect(vi.mocked(https.request)).toHaveBeenCalledTimes(1);
  });

  it("does not coerce partial numeric user ids into recipients", async () => {
    mockSuccessResponse();
    await sendText("Hello", "42abc");

    expect(firstHttpsRequestPayload()).toEqual({ text: "Hello" });
  });

  it("only disables TLS verification when explicitly requested", async () => {
    mockSuccessResponse();
    await sendText("Hello", undefined, true);
    const firstCall = firstHttpsRequestCall();
    expect(firstCall[1]?.rejectUnauthorized).toBe(false);
  });
});

describe("sendHostedFileUrl", () => {
  installFakeTimerHarness();

  it("returns indeterminate on an HTTP server failure", async () => {
    mockFailureResponse(500);
    const result = await sendFile();
    expect(result).toEqual({ status: "indeterminate" });
    expect(firstHttpsRequestPayload()).toEqual({ file_url: hostedCapabilityUrl });
  });

  it("returns indeterminate when the request outcome is lost", async () => {
    mockRequestErrorOnce(new Error("connection reset"));

    const result = await sendFile();

    expect(result).toEqual({ status: "indeterminate" });
  });

  it("returns not-dispatched when the transport proves it never connected", async () => {
    mockRequestErrorOnce(Object.assign(new Error("host not found"), { code: "ENOTFOUND" }));

    const result = await sendFile();

    expect(result).toEqual({ status: "not-dispatched" });
  });

  it("returns not-dispatched when request construction fails synchronously", async () => {
    vi.mocked(https.request).mockImplementationOnce(() => {
      throw new Error("request construction failed");
    });

    const result = await sendFile();

    expect(result).toEqual({ status: "not-dispatched" });
  });

  it("returns not-dispatched when the incoming webhook URL is malformed", async () => {
    const result = await sendFile("not-a-url");

    expect(result).toEqual({ status: "not-dispatched" });
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();
  });

  it("respects the shared send interval before posting a file URL", async () => {
    mockSuccessResponse();
    await sendText("hello");
    vi.mocked(https.request).mockClear();

    const promise = sendHostedFileUrl("https://nas.example.com/incoming", hostedCapabilityUrl);
    await Promise.resolve();
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(vi.mocked(https.request)).toHaveBeenCalledTimes(1);
  });

  it("paces each incoming webhook endpoint independently", async () => {
    mockSuccessResponse();
    const accountA = "https://nas.example.com/incoming?token=account-a";
    const accountB = "https://nas.example.com/incoming?token=account-b";
    const requestedUrls = () =>
      vi.mocked(https.request).mock.calls.map(([url]) => (url instanceof URL ? url.href : url));

    const sends = [
      sendMessage(accountA, "a1"),
      sendMessage(accountA, "a2"),
      sendMessage(accountA, "a3"),
      sendMessage(accountB, "b1"),
    ];

    await vi.advanceTimersByTimeAsync(1);
    expect(requestedUrls()).toEqual([accountA, accountB]);

    await vi.advanceTimersByTimeAsync(498);
    expect(requestedUrls()).toEqual([accountA, accountB]);

    await vi.advanceTimersByTimeAsync(1);
    expect(requestedUrls()).toEqual([accountA, accountB, accountA]);

    await vi.advanceTimersByTimeAsync(500);
    expect(requestedUrls()).toEqual([accountA, accountB, accountA, accountA]);
    await expect(Promise.all(sends)).resolves.toEqual(
      Array.from({ length: 4 }, () => ({ messageIds: [] })),
    );
  });
});

function mockUserListResponse(users: Array<Record<string, unknown>>, once = false) {
  const handler = responseHandler(200, [JSON.stringify({ success: true, data: { users } })]);
  if (once) {
    vi.mocked(https.get).mockImplementationOnce(handler);
  } else {
    vi.mocked(https.get).mockImplementation(handler);
  }
}

describe("resolveLegacyWebhookNameToChatUserId", () => {
  const baseUrl =
    "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22";
  const baseUrl2 =
    "https://nas2.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test-2%22";

  installFakeTimerHarness(10 * 60 * 1000);

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
    vi.mocked(https.get).mockImplementation(
      responseHandler(200, [responseBody.subarray(0, splitAt), responseBody.subarray(splitAt)]),
    );

    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: nickname,
    });

    expect(result).toBe(4);
  });

  it("resolves user by username when nickname does not match", async () => {
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "" },
      { user_id: 7, username: "she67", nickname: "sarah" },
    ]);
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "jmn67",
    });
    expect(result).toBe(4);
  });

  it("keeps user cache scoped per incoming URL", async () => {
    mockUserListResponse([{ user_id: 4, username: "jmn67", nickname: "jmn" }], true);
    mockUserListResponse([{ user_id: 9, username: "jmn67", nickname: "jmn" }], true);

    for (const [incomingUrl, expectedUserId] of [
      [baseUrl, 4],
      [baseUrl2, 9],
      [baseUrl, 4],
    ] as const) {
      await expect(
        resolveLegacyWebhookNameToChatUserId({
          incomingUrl,
          mutableWebhookUsername: "jmn",
        }),
      ).resolves.toBe(expectedUserId);
    }
    expect(https.get).toHaveBeenCalledTimes(2);
  });
});

describe("resolveLegacyWebhookNameToChatUserId user lookup", () => {
  installFakeTimerHarness();

  it("preserves the user_list transport error warning", async () => {
    const warns: string[] = [];
    vi.mocked(https.get).mockImplementationOnce(() => {
      const req = createMockRequestEmitter();
      process.nextTick(() => req.emit("error", new Error("lookup unavailable")));
      return req;
    });

    const userId = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: "https://lookup-error-nas.example.com/webapi/entry.cgi?method=chatbot",
      mutableWebhookUsername: "anyone",
      log: { warn: (...args) => warns.push(args.map(String).join(" ")) },
    });

    expect(userId).toBeUndefined();
    expect(warns).toEqual(["fetchChatUsers: HTTP error — lookup unavailable"]);
  });

  it("filters malformed user entries while keeping valid ones", async () => {
    mockUserListResponse([
      { user_id: "bad", username: "broken", nickname: "jmn" },
      { user_id: 4, username: "jmn67", nickname: "jmn" },
    ]);

    const userId = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl:
        "https://malformed-user-nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22",
      mutableWebhookUsername: "jmn",
    });

    expect(userId).toBe(4);
  });

  it("falls back when the user_list body exceeds the byte cap", async () => {
    const httpsGet = vi.mocked(https.get);
    const warns: string[] = [];
    // Single oversized Buffer: over 1 MiB cap without multi-write/destroy races.
    const oversized = Buffer.alloc(1 * 1024 * 1024 + 1, 0x78);
    const overflowUrl =
      "https://overflow-nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2";
    httpsGet.mockImplementation(responseHandler(200, [oversized]));

    const userId = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: overflowUrl,
      mutableWebhookUsername: "anyone",
      log: { warn: (...args) => warns.push(args.map(String).join(" ")) },
    });

    expect(userId).toBeUndefined();
    expect(warns.some((line) => line.includes("exceeded"))).toBe(true);
  });
});
