import type { IncomingMessage, ServerResponse } from "node:http";
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
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader: (name: string, value: string) => {
      res.headers[name] = value;
    },
    end: (payload?: string) => {
      res.body = payload ?? "";
      return res;
    },
  } as ServerResponse & { headers: Record<string, string>; body: string };
  return res;
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
    const target = createTarget();
    ingressReceive.mockResolvedValue({ kind: "ignored" });
    installSimplePipeline([target]);
    mockBody({
      commonEventObject: {
        hostApp: "CHAT",
        parameters: {
          openclaw_action: "approval",
          token: "token-1",
        },
      },
      authorizationEventObject: { systemIdToken: "addon-token" },
      chat: {
        eventTime: "2026-03-22T00:00:00.000Z",
        user: { name: "users/123" },
        buttonClickedPayload: {
          space: { name: "spaces/AAA" },
          message: { name: "spaces/AAA/messages/1" },
        },
      },
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
        space: { name: "spaces/AAA" },
        message: { name: "spaces/AAA/messages/1" },
        user: { name: "users/123" },
        eventTime: "2026-03-22T00:00:00.000Z",
        action: {
          parameters: [
            { key: "openclaw_action", value: "approval" },
            { key: "token", value: "token-1" },
          ],
        },
        commonEventObject: {
          parameters: {
            openclaw_action: "approval",
            token: "token-1",
          },
        },
      },
      target,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-openclaw-delivery-accepted"]).toBeUndefined();
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(res.body).toBe("{}");
  });

  it("waits for durable admission before acknowledging a message", async () => {
    const target = createTarget();
    installSimplePipeline([target]);
    const raw = {
      type: "MESSAGE",
      space: { name: "spaces/AAA" },
      message: { name: "spaces/AAA/messages/durable", text: "hello" },
    };
    mockBody(raw);
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
    expect(res.headers["x-openclaw-delivery-accepted"]).toBeUndefined();
    releaseAdmission({ kind: "durable" });
    await expect(handling).resolves.toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-openclaw-delivery-accepted"]).toBe("durable");
  });

  it("returns 503 instead of acknowledging when durable admission fails", async () => {
    const target = createTarget();
    installSimplePipeline([target]);
    mockBody({
      type: "MESSAGE",
      space: { name: "spaces/AAA" },
      message: { name: "spaces/AAA/messages/failed", text: "hello" },
    });
    resolveWebhookTargetWithAuthOrReject.mockResolvedValue(target);
    verifyGoogleChatRequest.mockResolvedValue({ ok: true });
    ingressReceive.mockRejectedValue(new Error("sqlite busy"));

    const { processEvent, res } = await runWebhookHandler("Bearer valid");

    expect(res.statusCode).toBe(503);
    expect(res.headers["x-openclaw-delivery-accepted"]).toBeUndefined();
    expect(res.body).toBe("failed to persist event");
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for a permanently invalid message identity", async () => {
    const target = createTarget();
    installSimplePipeline([target]);
    mockBody({
      type: "MESSAGE",
      space: { name: "spaces/AAA" },
      message: { text: "missing resource name" },
    });
    resolveWebhookTargetWithAuthOrReject.mockResolvedValue(target);
    verifyGoogleChatRequest.mockResolvedValue({ ok: true });
    ingressReceive.mockResolvedValue({
      kind: "invalid",
      message: "Google Chat MESSAGE event is missing message.name.",
    });

    const { processEvent, res } = await runWebhookHandler("Bearer valid");

    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("invalid payload");
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("logs WARN with reason when verification fails (unexpected principal)", async () => {
    const target = createTarget("acct-2");
    installSimplePipeline([target]);
    readJsonWebhookBodyOrReject.mockResolvedValue({
      ok: true,
      value: {
        commonEventObject: { hostApp: "CHAT" },
        authorizationEventObject: { systemIdToken: "bad-token" },
        chat: {
          messagePayload: {
            space: { name: "spaces/AAA" },
            message: { name: "spaces/AAA/messages/1", text: "hi" },
          },
        },
      },
    });
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
    const target = createTarget();
    installSimplePipeline([target]);
    mockBody({
      commonEventObject: { hostApp: "CHAT" },
      chat: {
        messagePayload: {
          space: { name: "spaces/AAA" },
          message: { name: "spaces/AAA/messages/1", text: "hello" },
        },
      },
    });
    const { processEvent, res } = await runWebhookHandler();

    expect(processEvent).not.toHaveBeenCalled();
    expect(target.runtime.log).toHaveBeenCalledWith(
      "[default] Google Chat webhook auth rejected: missing token",
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
  });
});

describe("warnAppPrincipalMisconfiguration", () => {
  it("warns when appPrincipal is missing for app-url audience", () => {
    const log = vi.fn();
    warnAppPrincipalMisconfiguration({
      accountId: "acct-missing",
      audienceType: "app-url",
      appPrincipal: undefined,
      log,
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[acct-missing] appPrincipal is missing for audienceType "app-url"; add-on token verification will fail. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.',
    );
  });

  it("warns when appPrincipal contains @ for app-url audience", () => {
    const log = vi.fn();
    warnAppPrincipalMisconfiguration({
      accountId: "acct-email",
      audienceType: "app-url",
      appPrincipal: "bot@example.iam.gserviceaccount.com",
      log,
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[acct-email] appPrincipal "bot@example.iam.gserviceaccount.com" looks like an email address. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.',
    );
  });

  it("does not warn for project-number audience even with missing appPrincipal", () => {
    const log = vi.fn();
    warnAppPrincipalMisconfiguration({
      accountId: "acct-pn",
      audienceType: "project-number",
      appPrincipal: undefined,
      log,
    });
    expect(log).not.toHaveBeenCalled();
  });
});
