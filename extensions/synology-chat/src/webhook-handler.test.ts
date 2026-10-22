// Synology Chat tests cover webhook handler plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { postRawWebhook, withServer } from "openclaw/plugin-sdk/test-env";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSynologyRuntime } from "./runtime.js";
import { makeFormBody, makeReq, makeRes, makeStalledReq } from "./test-http-utils.js";
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
type TestWebhookHandlerDeps = Omit<WebhookHandlerDeps, "receive"> & { deliver: TestDeliver };

function createWebhookHandler(deps: TestWebhookHandlerDeps) {
  const lifecycle: SynologyIngressLifecycle = {
    admission: "exclusive",
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(),
    onDeferred: vi.fn(),
    onAbandoned: vi.fn(),
  };
  return createWebhookHandlerWithIngress({
    ...deps,
    receive: async (rawEvent) => {
      await processSynologyWebhookIngressEvent({
        account: deps.account,
        rawEvent,
        lifecycle,
        deliver: deps.deliver,
        log: deps.log,
      });
      return { kind: "durable" };
    },
  });
}

function deliveredMessage(deliver: TestDeliver) {
  expect(deliver).toHaveBeenCalledTimes(1);
  return expectDefined(vi.mocked(deliver).mock.calls[0]?.[0], "delivered Synology message");
}

let accountSequence = 0;

function makeAccount(
  overrides: Partial<ResolvedSynologyChatAccount> = {},
): ResolvedSynologyChatAccount {
  return {
    accountId: `test-account-${++accountSequence}`,
    enabled: true,
    token: "valid-token",
    incomingUrl: "https://nas.example.com/incoming",
    webhookUrl: "https://gateway.example.com/webhook/synology",
    nasHost: "nas.example.com",
    webhookPath: "/webhook/synology",
    webhookPathSource: "default",
    dangerouslyAllowNameMatching: false,
    dangerouslyAllowInheritedWebhookPath: false,
    dmPolicy: "open",
    allowedUserIds: ["*"],
    rateLimitPerMinute: 30,
    botName: "TestBot",
    allowInsecureSsl: true,
    ...overrides,
  };
}

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
  handler: ReturnType<typeof createWebhookHandler>,
  body = validBody,
  options?: NonNullable<Parameters<typeof makeReq>[2]> & { remoteAddress?: string },
) {
  const req = makeReq("POST", body, options);
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
      deliver?: TestDeliver;
      account?: Partial<ResolvedSynologyChatAccount>;
    } = {},
  ) {
    const deliver = params.deliver ?? vi.fn().mockResolvedValue(null);
    return {
      deliver,
      handler: createWebhookHandler({
        account: makeAccount(params.account),
        deliver,
        log,
      }),
    };
  }

  it("rejects non-POST methods with 405", async () => {
    const { handler } = makeTestHandler();
    const req = makeReq("GET", "");
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toBe(405);
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
    const receive = vi.fn().mockRejectedValue(new Error("sqlite unavailable"));
    const handler = admissionHandler(receive);
    const res = await postToWebhook(handler);
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

  it.each([
    {
      name: "413 when the upload exceeds the pre-auth body limit",
      bodyTimeoutMs: 5_000,
      // Declared and sent in one write: the shape whose rejection used to race the flush.
      body: "x".repeat(64 * 1024 + 1),
      contentLength: undefined,
      statusLine: "HTTP/1.1 413 Payload Too Large",
      responseBody: JSON.stringify({ error: "Payload too large" }),
    },
    {
      name: "408 when the sender stalls mid-upload",
      bodyTimeoutMs: 50,
      // Promises more than is ever sent, so the read deadline fires with the request open.
      body: "x".repeat(16),
      contentLength: 64 * 1024,
      statusLine: "HTTP/1.1 408 Request Timeout",
      responseBody: JSON.stringify({ error: "Request body timeout" }),
    },
  ])("delivers $name and then closes the connection", async (scenario) => {
    const deliver = vi.fn();
    const handler = createWebhookHandler({
      account: makeAccount(),
      deliver,
      log,
      bodyTimeoutMs: scenario.bodyTimeoutMs,
    });
    await withServer(
      (req, res) => {
        void handler(req, res);
      },
      async (baseUrl) => {
        const result = await postRawWebhook({
          url: baseUrl + "/webhook/synology",
          body: scenario.body,
          contentLength: scenario.contentLength,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        });
        expect(result.statusLine).toBe(scenario.statusLine);
        expect(result.body).toBe(scenario.responseBody);
        expect(result.closedByServer).toBe(true);
        expect(deliver).not.toHaveBeenCalled();
      },
    );
  });

  it("rejects excess concurrent pre-auth body reads from the same remote IP", async () => {
    const { handler } = makeTestHandler({ deliver: vi.fn() });
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
    const weakToken = "00000129";
    const { deliver, handler } = makeTestHandler({
      account: { token: weakToken, rateLimitPerMinute: 5 },
    });
    let guessedToken: string | null = null;
    let saw429 = false;
    for (let i = 0; i < 130; i += 1) {
      const candidate = String(i).padStart(8, "0");
      const res = await postToWebhook(handler, formBody({ token: candidate }), {
        remoteAddress: "203.0.113.10",
      });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
      if (res.status === 204) {
        guessedToken = candidate;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(saw429).toBe(true);
    expect(guessedToken).toBeNull();
    const lockedRes = await postToWebhook(handler, formBody({ token: weakToken }), {
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
    expect(log.info).toHaveBeenCalledWith("Message from json-user (123): len=15");
  });

  it("rejects malformed application/json with a stable parser error", async () => {
    const { deliver, handler } = makeTestHandler();
    const res = await postToWebhook(handler, "{not json", {
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("Invalid request body");
    expect(deliver).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "Failed to parse webhook payload",
      expect.objectContaining({ message: "Invalid JSON body" }),
    );
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

  it.each([
    { dmPolicy: "allowlist", bodyContains: "Allowlist is empty" },
    { dmPolicy: "disabled", bodyContains: "disabled" },
  ] as const)("returns 403 for $dmPolicy DMs", async ({ dmPolicy, bodyContains }) => {
    const { handler, deliver } = makeTestHandler({ account: { dmPolicy, allowedUserIds: [] } });
    const res = await postToWebhook(handler);
    expect(res.status).toBe(403);
    expect(res.body).toContain(bodyContains);
    expect(deliver).not.toHaveBeenCalled();
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
    const body = formBody({
      text: "!bot Hello there",
      trigger_word: "!bot",
      post_id: "post-trigger",
    });
    const res = await postToWebhook(handler, body);
    expect(res.status).toBe(204);
    expect(deliveredMessage(deliver).body).toBe("Hello there");
  });

  it.each([456, undefined])("resolves break-glass reply identity (%s)", async (resolved) => {
    resolveLegacyWebhookNameToChatUserId.mockResolvedValueOnce(resolved);
    const { deliver, handler } = makeTestHandler({
      account: { dangerouslyAllowNameMatching: true },
      deliver: vi.fn().mockResolvedValue(undefined),
    });
    expect((await postToWebhook(handler)).status).toBe(204);
    expect(resolveLegacyWebhookNameToChatUserId).toHaveBeenCalledWith({
      incomingUrl: "https://nas.example.com/incoming",
      mutableWebhookUsername: "testuser",
      allowInsecureSsl: true,
      log,
    });
    if (resolved === undefined) {
      expect(log.warn).toHaveBeenCalledWith(
        'Could not resolve Chat API user_id for "testuser" — falling back to webhook user_id 123. Reply delivery may fail.',
      );
    }
    expect(deliveredMessage(deliver)).toMatchObject({
      from: "123",
      chatUserId: String(resolved ?? 123),
    });
  });

  it("awaits deliver directly with no local hardcoded timeout wrapper", async () => {
    // The former 120s wrapper overrode agents.defaults.timeoutSeconds.
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    try {
      const deliver = vi.fn().mockResolvedValue(undefined);
      const { handler } = makeTestHandler({
        deliver,
      });
      const res = await postToWebhook(handler);
      expect(res.status).toBe(204);
      const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
      const longDelays = delays.filter((d) => typeof d === "number" && d >= 120_000);
      expect(longDelays).toEqual([]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
