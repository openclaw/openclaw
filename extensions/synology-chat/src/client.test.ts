// Synology Chat tests cover client plugin behavior.
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { synologyChatPlugin as plugin } from "./channel.js";
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
const post = vi.mocked(https.request);
const get = vi.mocked(https.get);
let fakeNowMs = 1_700_000_000_000;

type RequestCallback = (res: IncomingMessage) => void;
type RequestHandler = (
  url: string | URL,
  options: RequestOptions,
  callback?: RequestCallback,
) => ClientRequest;
type MockHttpCall = [
  string | URL,
  RequestOptions & { rejectUnauthorized?: boolean },
  RequestCallback?,
];
type ResponseStream = IncomingMessage & PassThrough;

function requestCall(label = "Synology Chat HTTPS request"): MockHttpCall {
  const call = post.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call as MockHttpCall;
}

function payload(): unknown {
  const req = post.mock.results[0]?.value;
  if (!req) {
    throw new Error("expected Synology Chat webhook request");
  }
  const body = vi.mocked(req.write).mock.calls[0]?.[0];
  if (typeof body !== "string") {
    throw new Error("expected Synology Chat webhook body");
  }
  return JSON.parse(decodeURIComponent(body.replace(/^payload=/, "")));
}

function response(statusCode: number): ResponseStream {
  const res = new PassThrough() as PassThrough & Partial<IncomingMessage>;
  res.statusCode = statusCode;
  return res as unknown as ResponseStream;
}

function request(): ClientRequest {
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

function responseHandler(statusCode: number, chunks: Array<string | Buffer>): RequestHandler {
  return (_url, _options, callback) => {
    const res = response(statusCode);
    process.nextTick(() => {
      callback?.(res);
      for (const chunk of chunks) {
        res.write(chunk);
      }
      res.end();
    });
    return request();
  };
}

function mockResponse(statusCode: number, body: string) {
  post.mockImplementation(responseHandler(statusCode, [body]));
}

function mockSuccessResponse() {
  mockResponse(200, '{"success":true}');
}

function mockRequestErrorOnce(error: Error) {
  post.mockImplementationOnce((() => {
    const req = request();
    process.nextTick(() => req.emit("error", error));
    return req;
  }) as RequestHandler);
}

function useTimers(advanceMs = 10_000) {
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

describe("Synology outbound channel boundary", () => {
  useTimers();
  beforeEach(() => {
    vi.stubEnv("SYNOLOGY_CHAT_TOKEN", "");
    vi.stubEnv("SYNOLOGY_CHAT_INCOMING_URL", "");
  });
  afterEach(() => vi.unstubAllEnvs());
  const channel = {
    token: "default-token",
    incomingUrl: webhookUrl,
    webhookUrl: "",
    accounts: {
      beta: {
        token: "beta-token",
        incomingUrl: "https://nas-beta/incoming",
        allowInsecureSsl: true,
      },
    },
  };
  const cfg = { channels: { "synology-chat": channel } };
  const notify = () => plugin.pairing.notifyApproval!({ cfg, id: "USER2", accountId: "beta" });

  it("notifies through the approved account", async () => {
    mockSuccessResponse();
    await settleTimers(notify());
    expect(requestCall()[0]).toBe("https://nas-beta/incoming");
    expect(requestCall()[1].rejectUnauthorized).toBe(false);
    expect(payload()).toEqual({
      text: "OpenClaw: your access has been approved.",
    });
    expect(https.request).toHaveBeenCalledOnce();
  });

  it("rejects a notification when the selected account's send fails", async () => {
    mockResponse(403, '{"success":false}');
    await settleTimers(expect(notify()).rejects.toThrow("Failed to send message to Synology Chat"));
    expect(https.request).toHaveBeenCalledOnce();
  });

  it("rejects a notification without a configured incoming URL", async () => {
    await expect(
      plugin.pairing.notifyApproval!({
        cfg: { channels: { "synology-chat": { accounts: { beta: { token: "beta-token" } } } } },
        id: "42",
        accountId: "beta",
      }),
    ).rejects.toThrow("incoming URL not configured");
    expect(https.request).not.toHaveBeenCalled();
  });

  it("formats links without inventing a platform receipt", async () => {
    mockSuccessResponse();
    const malformedLink = `[${"\\".repeat(32)}`;
    const text = `**Read** [the docs](https://example.com/a_(b)) [titled](https://example.com "Documentation") \`[literal](https://example.com)\` \\[escaped](https://example.com) [x > y](https://example.com) [bad](<https://example.com) [bad title](https://example.com "oops') ![logo](https://example.com/logo.png) ${malformedLink}`;
    const expected = `**Read** <https://example.com/a_(b)|the docs> <https://example.com|titled> \`[literal](https://example.com)\` \\[escaped](https://example.com) [x > y](https://example.com) [bad](<https://example.com) [bad title](https://example.com "oops') ![logo](https://example.com/logo.png) ${malformedLink}`;
    const result = await settleTimers(
      plugin.outbound.sendText({
        cfg: { channels: { "synology-chat": { ...channel, allowInsecureSsl: true } } },
        text,
        to: "user1",
      }),
    );
    expect(result).toMatchObject({
      channel: "synology-chat",
      target: { kind: "chat", id: "user1" },
      messageId: "",
      receipt: { platformMessageIds: [], parts: [], threadId: "user1" },
    });
    expect(result.receipt.primaryPlatformMessageId).toBeUndefined();
    expect(requestCall()[1].rejectUnauthorized).toBe(false);
    expect(payload()).toEqual({ text: expected });
  });
});

describe("Synology Chat TLS verification defaults", () => {
  useTimers();

  it.each([
    { name: "sendMessage", refused: false },
    { name: "sendMessage", refused: true },
    { name: "sendHostedFileUrl", refused: false },
    { name: "sendHostedFileUrl", refused: true },
  ])("prepares $name webhook POST before handoff (refused=$refused)", async ({ name, refused }) => {
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
    post.mockImplementation(((...args) => {
      handedOff.resolve();
      const res = response(200);
      void acknowledgment.promise.then(() => {
        args[2]?.(res);
        res.end('{"success":true}');
      });
      return request();
    }) as RequestHandler);
    const sending =
      name === "sendMessage"
        ? sendMessage(webhookUrl, "Hello")
        : sendHostedFileUrl(webhookUrl, hostedCapabilityUrl);
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
        expect(requestCall()[1]?.rejectUnauthorized).toBe(true);
      }
    } finally {
      prepared.resolve();
      acknowledgment.resolve();
      await sending.catch(() => {});
      capture.mockRestore();
    }
  });
});

describe("sendMessage", () => {
  useTimers();

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
    post.mockImplementation(((_url, _options, callback) => {
      requests += 1;
      const lastChunk = requests === 3;
      process.nextTick(() => {
        const res = response(200);
        callback?.(res);
        res.end(JSON.stringify({ success: !lastChunk }));
      });
      return request();
    }) as RequestHandler);
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
    expect(post).toHaveBeenCalledOnce();
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
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("preserves HTTP-successful webhook responses with oversized rejection envelopes", async () => {
    mockResponse(200, JSON.stringify({ success: false, padding: "x".repeat(1 * 1024 * 1024) }));
    const result = await sendText();
    expect(result).toEqual({ messageIds: [] });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not coerce partial numeric user ids into recipients", async () => {
    mockSuccessResponse();
    await sendText("Hello", "42abc");
    expect(payload()).toEqual({ text: "Hello" });
  });

  it("only disables TLS verification when explicitly requested", async () => {
    mockSuccessResponse();
    await sendText("Hello", undefined, true);
    const firstCall = requestCall();
    expect(firstCall[1]?.rejectUnauthorized).toBe(false);
  });
});

describe("sendHostedFileUrl", () => {
  useTimers();

  it("returns indeterminate on an HTTP server failure", async () => {
    mockResponse(500, "error");
    const result = await sendFile();
    expect(result).toEqual({ status: "indeterminate" });
    expect(payload()).toEqual({ file_url: hostedCapabilityUrl });
  });

  it.each([
    { error: new Error("connection reset"), status: "indeterminate" },
    {
      error: Object.assign(new Error("host not found"), { code: "ENOTFOUND" }),
      status: "not-dispatched",
    },
  ])("returns $status for $error", async ({ error, status }) => {
    mockRequestErrorOnce(error);
    expect(await sendFile()).toEqual({ status });
  });

  it("returns not-dispatched when request construction fails synchronously", async () => {
    post.mockImplementationOnce(() => {
      throw new Error("request construction failed");
    });
    const result = await sendFile();
    expect(result).toEqual({ status: "not-dispatched" });
  });

  it("returns not-dispatched when the incoming webhook URL is malformed", async () => {
    const result = await sendFile("not-a-url");
    expect(result).toEqual({ status: "not-dispatched" });
    expect(post).not.toHaveBeenCalled();
  });

  it("respects the shared send interval before posting a file URL", async () => {
    mockSuccessResponse();
    await sendText("hello");
    post.mockClear();
    const promise = sendHostedFileUrl("https://nas.example.com/incoming", hostedCapabilityUrl);
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("paces each incoming webhook endpoint independently", async () => {
    mockSuccessResponse();
    const accountA = "https://nas.example.com/incoming?token=account-a";
    const accountB = "https://nas.example.com/incoming?token=account-b";
    const requestedUrls = () =>
      post.mock.calls.map(([url]) => (url instanceof URL ? url.href : url));
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

function mockUsers(users: Array<Record<string, unknown>>, once = false) {
  const handler = responseHandler(200, [JSON.stringify({ success: true, data: { users } })]);
  if (once) {
    get.mockImplementationOnce(handler);
  } else {
    get.mockImplementation(handler);
  }
}

describe("resolveLegacyWebhookNameToChatUserId", () => {
  const baseUrl =
    "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22";
  const baseUrl2 =
    "https://nas2.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test-2%22";

  useTimers(10 * 60 * 1000);

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
    get.mockImplementation(
      responseHandler(200, [responseBody.subarray(0, splitAt), responseBody.subarray(splitAt)]),
    );
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: nickname,
    });
    expect(result).toBe(4);
  });

  it("resolves user by username when nickname does not match", async () => {
    mockUsers([
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
    mockUsers([{ user_id: 4, username: "jmn67", nickname: "jmn" }], true);
    mockUsers([{ user_id: 9, username: "jmn67", nickname: "jmn" }], true);
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
  useTimers();

  it("preserves the user_list transport error warning", async () => {
    const warns: string[] = [];
    get.mockImplementationOnce(() => {
      const req = request();
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
    mockUsers([
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
    const httpsGet = get;
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
