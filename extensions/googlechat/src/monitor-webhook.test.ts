import type { IncomingMessage, ServerResponse } from "node:http";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import type { FixedWindowRateLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookTarget } from "./monitor-types.js";

const readJsonWebhookBodyOrReject = vi.hoisted(() => vi.fn());
const runDetachedWebhookWork = vi.hoisted(() => vi.fn((run: () => Promise<void>) => run()));
const resolveWebhookTargetWithAuthOrReject = vi.hoisted(() => vi.fn());
const withResolvedWebhookRequestPipeline = vi.hoisted(() => vi.fn());
const verifyGoogleChatRequest = vi.hoisted(() => vi.fn());
const ingressReceive = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/webhook-request-guards", () => ({
  readJsonWebhookBodyOrReject,
  runDetachedWebhookWork,
}));

vi.mock("openclaw/plugin-sdk/webhook-targets", () => ({
  canonicalizeWebhookRouteKey: (raw: string) =>
    raw
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase(),
  normalizeWebhookPath: (raw: string) => raw,
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
}));

vi.mock("./auth.js", () => ({
  verifyGoogleChatRequest,
}));

let createGoogleChatWebhookRequestHandler: typeof import("./monitor-webhook.js").createGoogleChatWebhookRequestHandler;
let warnAppPrincipalMisconfiguration: typeof import("./monitor-webhook.js").warnAppPrincipalMisconfiguration;

function createRequest(options?: {
  authorization?: string;
  remoteAddress?: string;
}): IncomingMessage {
  return {
    method: "POST",
    url: "/googlechat",
    headers: {
      authorization: options?.authorization ?? "",
      "content-type": "application/json",
    },
    socket: { remoteAddress: options?.remoteAddress ?? "203.0.113.10" },
  } as IncomingMessage;
}

function createResponse() {
  return Object.assign(createMockServerResponse(), { statusCode: 0 });
}

function createTarget(accountId = "default") {
  return {
    account: { accountId, config: { appPrincipal: "chat-app" } },
    runtime: { error: vi.fn(), log: vi.fn() },
    statusSink: vi.fn(),
    audienceType: "app-url",
    audience: "https://example.com/googlechat",
  };
}

function mockBody(value: unknown) {
  readJsonWebhookBodyOrReject.mockResolvedValue({ ok: true, value });
}

function message(name: string | null = "1", text = "hello") {
  return {
    type: "MESSAGE",
    space: { name: "spaces/AAA" },
    message: { ...(name === null ? {} : { name: `spaces/AAA/messages/${name}` }), text },
  };
}

function prepare(body: unknown, accountId?: string) {
  const target = createTarget(accountId);
  installSimplePipeline([target]);
  mockBody(body);
  return target;
}

function addonMessage(token?: string) {
  const raw = message();
  return {
    commonEventObject: { hostApp: "CHAT" },
    ...(token ? { authorizationEventObject: { systemIdToken: token } } : {}),
    chat: { messagePayload: { space: raw.space, message: raw.message } },
  };
}

function createHandler(
  overrides: Partial<Parameters<typeof createGoogleChatWebhookRequestHandler>[0]> = {},
) {
  return createGoogleChatWebhookRequestHandler({
    webhookTargets: new Map(),
    webhookRateLimiter: {
      isRateLimited: vi.fn(() => false),
      size: vi.fn(() => 0),
      clear: vi.fn(),
    },
    webhookInFlightLimiter: {} as never,
    processEvent: vi.fn(async () => {}),
    ...overrides,
  });
}

function installSimplePipeline(targets: Array<Record<string, unknown>>) {
  for (const target of targets) {
    target.ingress = { receive: ingressReceive };
  }
  withResolvedWebhookRequestPipeline.mockImplementation(
    async ({
      handle,
      req,
      res,
    }: {
      handle: (input: {
        targets: unknown[];
        req: IncomingMessage;
        res: ServerResponse;
      }) => Promise<unknown>;
      req: IncomingMessage;
      res: ServerResponse;
    }) =>
      await handle({
        targets,
        req,
        res,
      }),
  );
}

async function runWebhookHandler(authorization?: string) {
  const processEvent = vi.fn(async () => {});
  const handler = createHandler({ processEvent });
  const req = createRequest({ authorization });
  const res = createResponse();
  await expect(handler(req, res)).resolves.toBe(true);
  return { processEvent, res };
}

describe("googlechat monitor webhook", () => {
  beforeAll(async () => {
    ({ createGoogleChatWebhookRequestHandler, warnAppPrincipalMisconfiguration } =
      await import("./monitor-webhook.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ingressReceive.mockResolvedValue({ kind: "durable" });
    resolveWebhookTargetWithAuthOrReject.mockImplementation(async ({ isMatch, targets, res }) => {
      for (const target of targets) {
        if (await isMatch(target)) {
          return target;
        }
      }
      res.statusCode = 401;
      res.end("unauthorized");
      return null;
    });
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/webhook-request-guards");
    vi.doUnmock("openclaw/plugin-sdk/webhook-targets");
    vi.doUnmock("./auth.js");
    vi.resetModules();
  });

  it("uses unknown in the rate-limit bucket when a trusted proxy omits client headers", async () => {
    const rateLimiter: FixedWindowRateLimiter = {
      isRateLimited: vi.fn(() => false),
      size: vi.fn(() => 0),
      clear: vi.fn(),
    };
    const webhookTargets = new Map<string, WebhookTarget[]>([
      [
        "/googlechat",
        [
          {
            account: createTarget().account,
            config: { gateway: { trustedProxies: ["10.0.0.0/24"] } },
            runtime: {},
            core: {} as never,
            path: "/googlechat",
            mediaMaxMb: 20,
          } as unknown as WebhookTarget,
        ],
      ],
    ]);
    const webhookInFlightLimiter = {} as never;
    const processEvent = vi.fn(async () => {});
    const handler = createHandler({
      webhookTargets,
      webhookRateLimiter: rateLimiter,
      webhookInFlightLimiter,
      processEvent,
    });
    const req = createRequest({ remoteAddress: "10.0.0.1" });
    const res = createResponse();
    withResolvedWebhookRequestPipeline.mockResolvedValue(true);

    await expect(handler(req, res)).resolves.toBe(true);

    expect(withResolvedWebhookRequestPipeline).toHaveBeenCalledWith({
      req,
      res,
      targetsByPath: webhookTargets,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      rateLimiter,
      rateLimitKey: "/googlechat:unknown",
      inFlightLimiter: webhookInFlightLimiter,
      handle: expect.any(Function),
    });
  });

  it("normalizes add-on card-click payloads for approval actions", async () => {
    ingressReceive.mockResolvedValue({ kind: "ignored" });
    const parameters = { openclaw_action: "approval", token: "token-1" };
    const space = { name: "spaces/AAA" };
    const clickedMessage = { name: "spaces/AAA/messages/1" };
    const user = { name: "users/123" };
    const eventTime = "2026-03-22T00:00:00.000Z";
    const target = prepare({
      commonEventObject: { hostApp: "CHAT", parameters },
      authorizationEventObject: { systemIdToken: "addon-token" },
      chat: { eventTime, user, buttonClickedPayload: { space, message: clickedMessage } },
    });
    verifyGoogleChatRequest.mockResolvedValue({ ok: true });
    const { processEvent, res } = await runWebhookHandler();

    expect(verifyGoogleChatRequest).toHaveBeenCalledWith({
      bearer: "addon-token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
      expectedAddOnPrincipal: "chat-app",
    });
    expect(processEvent).toHaveBeenCalledWith(
      {
        type: "CARD_CLICKED",
        space,
        message: clickedMessage,
        user,
        eventTime,
        action: {
          parameters: [
            { key: "openclaw_action", value: "approval" },
            { key: "token", value: "token-1" },
          ],
        },
        commonEventObject: { parameters },
      },
      target,
    );
    expect(res).toMatchObject({ statusCode: 200, body: "{}" });
    expect(res.getHeader("Content-Type")).toBe("application/json");
    expect(res.getHeader("x-openclaw-delivery-accepted")).toBeUndefined();
  });

  it("waits for durable admission before acknowledging a message", async () => {
    const raw = message("durable");
    const target = prepare(raw);
    resolveWebhookTargetWithAuthOrReject.mockResolvedValue(target);
    verifyGoogleChatRequest.mockResolvedValue({ ok: true });
    let releaseAdmission: (result: { kind: "durable" }) => void = () => {};
    ingressReceive.mockImplementation(
      () =>
        new Promise<{ kind: "durable" }>((resolve) => {
          releaseAdmission = resolve;
        }),
    );
    const handler = createHandler();
    const res = createResponse();
    const handling = handler(createRequest({ authorization: "Bearer valid" }), res);

    await vi.waitFor(() => expect(ingressReceive).toHaveBeenCalledWith(raw));
    expect(res.statusCode).toBe(0);
    expect(res.getHeader("x-openclaw-delivery-accepted")).toBeUndefined();
    releaseAdmission({ kind: "durable" });
    await expect(handling).resolves.toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.getHeader("x-openclaw-delivery-accepted")).toBe("durable");
  });

  it.each([
    {
      name: "failed durable admission",
      invalid: false,
      statusCode: 503,
      body: "failed to persist event",
    },
    { name: "invalid message identity", invalid: true, statusCode: 400, body: "invalid payload" },
  ])("rejects $name without dispatch", async ({ invalid, statusCode, body }) => {
    const target = prepare(
      message(invalid ? null : "failed", invalid ? "missing resource name" : "hello"),
    );
    resolveWebhookTargetWithAuthOrReject.mockResolvedValue(target);
    verifyGoogleChatRequest.mockResolvedValue({ ok: true });
    if (invalid) {
      ingressReceive.mockResolvedValue({
        kind: "invalid",
        message: "Google Chat MESSAGE event is missing message.name.",
      });
    } else {
      ingressReceive.mockRejectedValue(new Error("sqlite busy"));
    }
    const { processEvent, res } = await runWebhookHandler("Bearer valid");
    expect(res).toMatchObject({ statusCode, body });
    if (!invalid) {
      expect(res.getHeader("x-openclaw-delivery-accepted")).toBeUndefined();
    }
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("logs WARN with reason when verification fails (unexpected principal)", async () => {
    const target = prepare(addonMessage("bad-token"), "acct-2");
    verifyGoogleChatRequest.mockResolvedValue({
      ok: false,
      reason: "unexpected add-on principal: 999999999999999999999",
    });
    const { processEvent, res } = await runWebhookHandler();

    expect(target.runtime.log).toHaveBeenCalledWith(
      "[acct-2] Google Chat webhook auth rejected: unexpected add-on principal: 999999999999999999999",
    );
    expect(processEvent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects missing add-on bearer tokens before dispatch", async () => {
    const target = prepare(addonMessage());
    const { processEvent, res } = await runWebhookHandler();

    expect(processEvent).not.toHaveBeenCalled();
    expect(target.runtime.log).toHaveBeenCalledWith(
      "[default] Google Chat webhook auth rejected: missing token",
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
  });
});

it.each([
  {
    accountId: "acct-missing",
    audienceType: "app-url",
    appPrincipal: undefined,
    warning:
      '[acct-missing] appPrincipal is missing for audienceType "app-url"; add-on token verification will fail. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.',
  },
  {
    accountId: "acct-email",
    audienceType: "app-url",
    appPrincipal: "bot@example.iam.gserviceaccount.com",
    warning:
      '[acct-email] appPrincipal "bot@example.iam.gserviceaccount.com" looks like an email address. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.',
  },
  {
    accountId: "acct-pn",
    audienceType: "project-number",
    appPrincipal: undefined,
    warning: undefined,
  },
])("checks app principal configuration: $accountId", ({ warning, ...config }) => {
  const log = vi.fn();
  warnAppPrincipalMisconfiguration({ ...config, log });
  expect(log.mock.calls).toEqual(warning ? [[warning]] : []);
});
