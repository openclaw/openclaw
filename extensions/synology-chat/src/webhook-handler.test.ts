import { expectDefined } from "@openclaw/normalization-core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { postRawWebhook, withServer } from "openclaw/plugin-sdk/test-env";
import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";
import { setSynologyRuntime } from "./runtime.js";
import {
  makeAccount as accountFixture,
  makeFormBody,
  makeReq,
  makeRes,
  makeStalledReq,
} from "./test-http-utils.js";
import type { ResolvedSynologyChatAccount } from "./types.js";
import type { WebhookHandlerDeps } from "./webhook-handler.js";
import type { SynologyIngressLifecycle } from "./webhook-ingress.js";
const clientModule = await import("./client.js");
const resolveLegacyWebhookNameToChatUserId = vi
  .spyOn(clientModule, "resolveLegacyWebhookNameToChatUserId")
  .mockResolvedValue(undefined);
const {
  createWebhookHandler: createWebhookHandlerWithIngress,
  processSynologyWebhookIngressEvent,
} = await import("./webhook-handler.js");

type TestDeliver = Parameters<typeof processSynologyWebhookIngressEvent>[0]["deliver"];

function deliveredMessage(deliver: TestDeliver) {
  expect(deliver).toHaveBeenCalledTimes(1);
  return expectDefined(vi.mocked(deliver).mock.calls[0]?.[0], "delivered Synology message");
}

let accountSequence = 0;

const makeAccount = (overrides: Partial<ResolvedSynologyChatAccount> = {}) =>
  accountFixture({ accountId: `test-account-${++accountSequence}`, ...overrides });

function formBody(overrides: Record<string, string> = {}) {
  return makeFormBody({
    token: "valid-token",
    user_id: "123",
    username: "testuser",
    text: "Hello bot",
    post_id: "post-123",
    ...overrides,
  });
}
const validBody = formBody();

async function postToWebhook(
  handler: ReturnType<typeof createWebhookHandlerWithIngress>,
  body = validBody,
  options?: NonNullable<Parameters<typeof makeReq>[2]> & { remoteAddress?: string },
  method = "POST",
) {
  const req = makeReq(method, body, options);
  if (options?.remoteAddress) {
    Object.assign(req.socket, { remoteAddress: options.remoteAddress });
  }
  const res = makeRes();
  await handler(req, res);
  return res;
}

describe("createWebhookHandler", () => {
  let log: NonNullable<WebhookHandlerDeps["log"]>;

  beforeEach(() => {
    setSynologyRuntime(createPluginRuntimeMock());
    resolveLegacyWebhookNameToChatUserId.mockClear();
    resolveLegacyWebhookNameToChatUserId.mockResolvedValue(undefined);
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  function admissionHandler(receive: WebhookHandlerDeps["receive"]) {
    return createWebhookHandlerWithIngress({ account: makeAccount(), receive, log });
  }

  function makeTestHandler(
    params: {
      account?: Partial<ResolvedSynologyChatAccount>;
      bodyTimeoutMs?: number;
    } = {},
  ) {
    const deliver = vi.fn().mockResolvedValue(null);
    const account = makeAccount(params.account);
    const lifecycle: SynologyIngressLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };
    return {
      deliver,
      handler: createWebhookHandlerWithIngress({
        account,
        log,
        bodyTimeoutMs: params.bodyTimeoutMs,
        receive: async (rawEvent) => {
          await processSynologyWebhookIngressEvent({ account, rawEvent, lifecycle, deliver, log });
          return { kind: "durable" };
        },
      }),
    };
  }

  it.each([
    ["method", 405, "Method not allowed"],
    ["json", 400, "Invalid request body"],
    ["allowlist", 403, "Allowlist is empty"],
    ["disabled", 403, "disabled"],
  ] as const)("rejects %s requests", async (kind, status, error) => {
    const account =
      kind === "allowlist" || kind === "disabled"
        ? { dmPolicy: kind, allowedUserIds: [] }
        : undefined;
    const { handler, deliver } = makeTestHandler({ account });
    const res = await postToWebhook(
      handler,
      kind === "json" ? "{not json" : validBody,
      kind === "json" ? { headers: { "content-type": "application/json" } } : undefined,
      kind === "method" ? "GET" : "POST",
    );
    expect(res.status).toBe(status);
    expect(res.body).toContain(error);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not acknowledge until durable admission completes", async () => {
    const { promise: admission, resolve } = Promise.withResolvers<{ kind: "durable" }>();
    const receive = vi.fn(() => admission);
    const handler = admissionHandler(receive);
    const res = makeRes();
    const pending = handler(makeReq("POST", validBody), res);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(res.status).toBe(0);
    expect(res.headers["x-openclaw-delivery-accepted"]).toBeUndefined();
    resolve({ kind: "durable" });
    await pending;
    expect(res.status).toBe(204);
    expect(res.headers["x-openclaw-delivery-accepted"]).toBe("durable");
  });

  it("returns 503 without acknowledging when durable admission fails", async () => {
    const res = await postToWebhook(
      admissionHandler(vi.fn().mockRejectedValue(new Error("sqlite unavailable"))),
    );
    expect(res.status).toBe(503);
    expect(res.headers["x-openclaw-delivery-accepted"]).toBeUndefined();
    expect(res.body).toContain("Webhook admission failed");
  });

  it("returns 400 without admission when the request stream fails", async () => {
    const receive = vi.fn();
    const handler = admissionHandler(receive);
    const req = makeStalledReq("POST");
    const res = makeRes();
    const pending = handler(req, res);
    req.emit("data", Buffer.from(validBody));
    req.emit("error", new Error("request stream failed"));
    await pending;
    expect(res.status).toBe(400);
    expect(res.body).toBe(JSON.stringify({ error: "Invalid request body" }));
    expect(res.headers["x-openclaw-delivery-accepted"]).toBeUndefined();
    expect(receive).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "flushes rejection before closing (stalled upload=%s)",
    async (stalled) => {
      const { handler, deliver } = makeTestHandler({ bodyTimeoutMs: stalled ? 50 : 5_000 });
      await withServer(
        (req, res) => {
          void handler(req, res);
        },
        async (baseUrl) => {
          const result = await postRawWebhook({
            url: baseUrl + "/webhook/synology",
            // Overflow arrives in one write; a stalled sender promises bytes it never sends.
            body: "x".repeat(stalled ? 16 : 64 * 1024 + 1),
            contentLength: stalled ? 64 * 1024 : undefined,
            headers: { "content-type": "application/x-www-form-urlencoded" },
          });
          expect(result.statusLine).toBe(
            stalled ? "HTTP/1.1 408 Request Timeout" : "HTTP/1.1 413 Payload Too Large",
          );
          expect(result.body).toBe(
            JSON.stringify({ error: stalled ? "Request body timeout" : "Payload too large" }),
          );
          expect(result.closedByServer).toBe(true);
          expect(deliver).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("rejects excess concurrent pre-auth body reads from the same remote IP", async () => {
    const { handler } = makeTestHandler();
    const requests = Array.from({ length: 12 }, () => {
      const req = makeStalledReq("POST");
      (req.socket as { remoteAddress?: string }).remoteAddress = "203.0.113.10";
      return req;
    });
    const responses = requests.map(() => makeRes());
    const runs = requests.map((req, index) =>
      handler(req, expectDefined(responses[index], `Synology response ${index}`)),
    );
    // Default maxInFlightPerKey is 8; 12 total requests leaves 4 rejected with 429.
    expect(responses.filter((res) => res.status === 0)).toHaveLength(8);
    expect(responses.filter((res) => res.status === 429)).toHaveLength(4);
    for (const req of requests) {
      req.emit("end");
    }
    await Promise.all(runs);
  });

  it("rate limits repeated invalid token guesses before the correct token can succeed", async () => {
    const { deliver, handler } = makeTestHandler({
      account: { token: "00000129", rateLimitPerMinute: 5 },
    });
    for (let i = 0; i < 6; i += 1) {
      const res = await postToWebhook(handler, formBody({ token: String(i).padStart(8, "0") }), {
        remoteAddress: "203.0.113.10",
      });
      expect(res.status).toBe(i < 5 ? 401 : 429);
    }
    const lockedRes = await postToWebhook(handler, validBody.replace("valid-token", "00000129"), {
      remoteAddress: "203.0.113.10",
    });
    expect(lockedRes.status).toBe(429);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not spend invalid-token budget on successful requests", async () => {
    const { deliver, handler } = makeTestHandler({
      account: { rateLimitPerMinute: 30 },
    });
    for (let i = 0; i < 11; i += 1) {
      const res = await postToWebhook(handler, validBody, {
        remoteAddress: "203.0.113.20",
      });
      expect(res.status).toBe(204);
    }
    expect(deliver).toHaveBeenCalledTimes(11);
  });

  it("accepts application/json with alias fields", async () => {
    const timer = vi.spyOn(global, "setTimeout");
    onTestFinished(() => timer.mockRestore());
    const { deliver, handler } = makeTestHandler();
    const res = await postToWebhook(
      handler,
      JSON.stringify({
        token: "valid-token",
        userId: "123",
        name: "json-user",
        message: "Hello from json",
        post_id: "post-json",
      }),
      { headers: { "content-type": "application/json" } },
    );
    expect(res.status).toBe(204);
    expect(deliveredMessage(deliver)).toMatchObject({
      body: "Hello from json",
      from: "123",
      senderName: "json-user",
      chatType: "direct",
      commandAuthorized: true,
      chatUserId: "123",
    });
    expect(resolveLegacyWebhookNameToChatUserId).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain("Hello from json");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("len=15"));
    expect(timer.mock.calls.some(([, ms]) => typeof ms === "number" && ms >= 120_000)).toBe(false);
  });

  it.each([
    { url: "/webhook/synology?token=valid-token" },
    { headers: { authorization: "Bearer valid-token" } },
  ])("accepts a token outside the body: %j", async (options) => {
    const { deliver, handler } = makeTestHandler();
    const body = makeFormBody({
      post_id: "post-tokenless",
      user_id: "123",
      username: "testuser",
      text: "hello",
    });
    const res = await postToWebhook(handler, body, {
      ...options,
      headers: { "content-type": "application/x-www-form-urlencoded", ...options.headers },
    });
    expect(res.status).toBe(204);
    expect(deliver).toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    const { handler } = makeTestHandler({ account: { rateLimitPerMinute: 1 } });
    const res1 = await postToWebhook(handler);
    expect(res1.status).toBe(204);
    const res2 = await postToWebhook(handler);
    expect(res2.status).toBe(429);
  });

  it("strips trigger word from message", async () => {
    const { deliver, handler } = makeTestHandler();
    const res = await postToWebhook(
      handler,
      formBody({ text: "!bot Hello there", trigger_word: "!bot" }),
    );
    expect(res.status).toBe(204);
    expect(deliveredMessage(deliver).body).toBe("Hello there");
  });

  it.each([456, undefined])("resolves break-glass reply identity (%s)", async (resolved) => {
    resolveLegacyWebhookNameToChatUserId.mockResolvedValueOnce(resolved);
    const { deliver, handler } = makeTestHandler({
      account: { dangerouslyAllowNameMatching: true },
    });
    expect((await postToWebhook(handler)).status).toBe(204);
    if (resolved === undefined) {
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to webhook user_id 123"),
      );
    }
    expect(deliveredMessage(deliver)).toMatchObject({
      from: "123",
      chatUserId: String(resolved ?? 123),
    });
  });
});
