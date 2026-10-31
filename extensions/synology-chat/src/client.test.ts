import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { synologyChatPlugin as plugin } from "./channel.js";
import {
  resolveLegacyWebhookNameToChatUserId as lookupUser,
  sendHostedFileUrl,
  sendMessage,
} from "./client.js";
import type { SynologyHostedMediaUrl } from "./outbound-media.js";

// Vitest hoists transport mocks before the static client import.
vi.mock("node:https", async () => {
  const actual = await vi.importActual<typeof import("node:https")>("node:https");
  const httpsRequest = vi.fn();
  const httpsGet = vi.fn();
  const httpsModule = { ...actual, request: httpsRequest, get: httpsGet };
  return { ...actual, default: httpsModule, request: httpsRequest, get: httpsGet };
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

function requestCall(): MockHttpCall {
  return expectDefined(post.mock.calls[0], "Synology HTTPS request") as MockHttpCall;
}

function payload(): unknown {
  const req = expectDefined(post.mock.results[0]?.value, "Synology Chat webhook request");
  const body = vi.mocked(req.write).mock.calls[0]?.[0];
  if (typeof body !== "string") {
    throw new Error("expected Synology Chat webhook body");
  }
  return JSON.parse(decodeURIComponent(body.replace(/^payload=/, "")));
}

function response(statusCode: number): ResponseStream {
  return Object.assign(new PassThrough(), { statusCode }) as ResponseStream;
}

function request(): ClientRequest {
  return Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  }) as unknown as ClientRequest;
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

function requestError(error: Error): RequestHandler {
  return () => {
    const req = request();
    process.nextTick(() => req.emit("error", error));
    return req;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  fakeNowMs += 10 * 60 * 1000;
  vi.setSystemTime(fakeNowMs);
  mockResponse(200, '{"success":true}');
});
afterEach(() => vi.useRealTimers());

const hostedCapabilityUrl =
  "https://gateway.example.com/webhook?__openclaw_synology_media_token_a=t" as SynologyHostedMediaUrl;

const webhookUrl = "https://nas.example.com/incoming";
const sendText = (text = "Hello", userId?: string) =>
  settleTimers(sendMessage(webhookUrl, text, userId));
const sendFile = () => settleTimers(sendHostedFileUrl(webhookUrl, hostedCapabilityUrl));

describe("Synology outbound channel boundary", () => {
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
    await settleTimers(notify());
    expect(requestCall()[0]).toBe("https://nas-beta/incoming");
    expect(requestCall()[1].rejectUnauthorized).toBe(false);
    expect(payload()).toEqual({
      text: "OpenClaw: your access has been approved.",
    });
  });

  it("rejects a notification when the selected account's send fails", async () => {
    mockResponse(403, '{"success":false}');
    await settleTimers(expect(notify()).rejects.toThrow("Failed to send message to Synology Chat"));
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

  it("formats links without rewriting code, escaped, or malformed links", async () => {
    expect(plugin.agentPrompt.messageToolHints()).toContain(
      "**Links**: Use `<URL|display text>` to create clickable links.",
    );
    const malformedLink = `[${"\\".repeat(32)}`;
    const text = `**Read** [the docs](https://example.com/a_(b)) [titled](https://example.com "Documentation") \`[literal](https://example.com)\` \\[escaped](https://example.com) [x > y](https://example.com) [bad](<https://example.com) [bad title](https://example.com "oops') ![logo](https://example.com/logo.png) ${malformedLink}`;
    const expected = `**Read** <https://example.com/a_(b)|the docs> <https://example.com|titled> \`[literal](https://example.com)\` \\[escaped](https://example.com) [x > y](https://example.com) [bad](<https://example.com) [bad title](https://example.com "oops') ![logo](https://example.com/logo.png) ${malformedLink}`;
    await settleTimers(
      plugin.outbound.sendText({
        cfg: { channels: { "synology-chat": { ...channel, allowInsecureSsl: true } } },
        text,
        to: "user1",
      }),
    );
    expect(requestCall()[1].rejectUnauthorized).toBe(false);
    expect(payload()).toEqual({ text: expected });
  });
});

describe("Synology Chat TLS verification defaults", () => {
  it.each([
    { name: "sendMessage", refused: false },
    { name: "sendMessage", refused: true },
    { name: "sendHostedFileUrl", refused: false },
    { name: "sendHostedFileUrl", refused: true },
  ])("prepares $name webhook POST before handoff (refused=$refused)", async ({ name, refused }) => {
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
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
    const sending =
      name === "sendMessage"
        ? sendMessage(webhookUrl, "Hello")
        : sendHostedFileUrl(webhookUrl, hostedCapabilityUrl);
    try {
      await Promise.race([
        preparing.promise,
        sending.then(() => {
          throw new Error("webhook POST bypassed preparation");
        }),
      ]);
      expect(https.request).not.toHaveBeenCalled();
      prepared.resolve();
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
      await sending.catch(() => {});
      capture.mockRestore();
    }
  });
});

describe("sendMessage", () => {
  it.each([
    ["123456", "18446744073709551615", ["18446744073709551615"]],
    ["999999", 25769804017, []],
    ["123456", 9007199254740992, []],
    ["123456", 0, []],
    ["123456", "invalid", []],
  ] as const)("keeps only usable post IDs for recipient %s: %s", async (recipient, postId, ids) => {
    mockResponse(
      200,
      JSON.stringify({
        success: true,
        data: { succ: { user_id_post_map: { [recipient]: postId } } },
      }),
    );
    await expect(sendText("Hello", "123456")).resolves.toEqual({ messageIds: ids });
  });

  it("preserves explicit rejection when identity metadata is malformed", async () => {
    mockResponse(200, JSON.stringify({ success: false, data: { succ: null } }));
    await expect(sendText("Hello", "123456")).resolves.toBe(false);
  });

  it("preserves acknowledged chunks when a later chunk is rejected", async () => {
    for (const success of [true, true, false]) {
      post.mockImplementationOnce(responseHandler(200, [JSON.stringify({ success })]));
    }
    await settleTimers(
      expect(sendMessage(webhookUrl, "a".repeat(4001), "42")).rejects.toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        message: "Failed to send message to Synology Chat (rejected)",
        deliveryResult: { visibleReplySent: true, content: "a".repeat(4000) },
      }),
    );
    expect(https.request).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["ECONNRESET", false],
    ["ENOTFOUND", true],
  ] as const)(
    "retries an aggregate only if every leaf is pre-connect (%s)",
    async (code, retries) => {
      const error = Object.assign(
        new AggregateError([
          Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
          Object.assign(new Error(code), { code }),
        ]),
        { code: "ECONNREFUSED" },
      );
      post.mockImplementationOnce(
        requestError(retries ? new TypeError("fetch failed", { cause: error }) : error),
      );
      expect(await sendText()).toEqual(retries ? { messageIds: [] } : false);
      expect(post).toHaveBeenCalledTimes(retries ? 2 : 1);
    },
  );

  it("preserves HTTP-successful webhook responses with oversized rejection envelopes", async () => {
    mockResponse(200, JSON.stringify({ success: false, padding: "x".repeat(1 * 1024 * 1024) }));
    const result = await sendText();
    expect(result).toEqual({ messageIds: [] });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not coerce partial numeric user ids into recipients", async () => {
    await sendText("Hello", "42abc");
    expect(payload()).toEqual({ text: "Hello" });
  });
});

describe("sendHostedFileUrl", () => {
  it.each([
    [new Error("connection reset"), "indeterminate"],
    [Object.assign(new Error("host not found"), { code: "ENOTFOUND" }), "not-dispatched"],
  ] as const)("classifies transport failure %s as %s", async (error, status) => {
    post.mockImplementationOnce(requestError(error));
    expect(await sendFile()).toEqual({ status });
  });

  it("returns not-dispatched when request construction fails synchronously", async () => {
    post.mockImplementationOnce(() => {
      throw new Error("request construction failed");
    });
    const result = await sendFile();
    expect(result).toEqual({ status: "not-dispatched" });
  });

  it("paces text and files together while keeping endpoints independent", async () => {
    const accountA = "https://nas.example.com/incoming?token=account-a";
    const accountB = "https://nas.example.com/incoming?token=account-b";
    const requestedUrls = () =>
      post.mock.calls.map(([url]) => (url instanceof URL ? url.href : url));
    const sends = [
      sendMessage(accountA, "a1"),
      sendHostedFileUrl(accountA, hostedCapabilityUrl),
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
    await Promise.all(sends);
  });
});

function mockUsers(users: Array<Record<string, unknown>>) {
  get.mockImplementationOnce(
    responseHandler(200, [JSON.stringify({ success: true, data: { users } })]),
  );
}

describe("resolveLegacyWebhookNameToChatUserId", () => {
  const baseUrl =
    "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22";
  const baseUrl2 =
    "https://nas2.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test-2%22";

  const lookup = (name: string, incomingUrl = baseUrl) =>
    lookupUser({ incomingUrl, mutableWebhookUsername: name });

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
    expect(await lookup(nickname)).toBe(4);
  });

  it("filters malformed identities and resolves both nickname and username", async () => {
    mockUsers([
      { user_id: "bad", username: "broken", nickname: "jmn" },
      { user_id: 4, username: "jmn67", nickname: "jmn" },
      { user_id: 7, username: "she67", nickname: "sarah" },
    ]);
    expect(await lookup("jmn")).toBe(4);
    expect(await lookup("jmn67")).toBe(4);
  });

  it("keeps user cache scoped per incoming URL", async () => {
    mockUsers([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    mockUsers([{ user_id: 9, username: "jmn67", nickname: "jmn" }]);
    for (const [incomingUrl, expectedUserId] of [
      [baseUrl, 4],
      [baseUrl2, 9],
      [baseUrl, 4],
    ] as const) {
      expect(await lookup("jmn", incomingUrl)).toBe(expectedUserId);
    }
    expect(https.get).toHaveBeenCalledTimes(2);
  });
});

describe("resolveLegacyWebhookNameToChatUserId user lookup", () => {
  it("preserves the user_list transport error warning", async () => {
    const warn = vi.fn();
    get.mockImplementationOnce(requestError(new Error("lookup unavailable")));
    const userId = await lookupUser({
      incomingUrl: "https://lookup-error-nas.example.com/webapi/entry.cgi?method=chatbot",
      mutableWebhookUsername: "anyone",
      log: { warn },
    });
    expect(userId).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith("fetchChatUsers: HTTP error — lookup unavailable");
  });
});
