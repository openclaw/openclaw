import crypto from "node:crypto";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { webhook } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createMockIncomingRequest, withServer } from "openclaw/plugin-sdk/test-env";
import { WEBHOOK_IN_FLIGHT_DEFAULTS } from "openclaw/plugin-sdk/webhook-request-guards";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLineWebhookSpool } from "./webhook-spool.js";
import { createEvent, withQueue } from "./webhook-spool.test-support.js";

type LineNodeWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type LineHandleWebhook = ReturnType<typeof import("./bot.js").createLineBot>["handleWebhook"];
type LineBotOptions = Parameters<typeof import("./bot.js").createLineBot>[0];

const { createLineBotMock, registerWebhookTargetWithPluginRouteMock, unregisterHttpMock } =
  vi.hoisted(() => ({
    createLineBotMock: vi.fn((_options: LineBotOptions) => ({
      account: { accountId: "default" },
      handleWebhook: vi.fn<LineHandleWebhook>().mockResolvedValue("durable"),
      stop: vi.fn(async () => undefined),
    })),
    registerWebhookTargetWithPluginRouteMock: vi.fn(),
    unregisterHttpMock: vi.fn(),
  }));

let monitorLineProvider: typeof import("./monitor.js").monitorLineProvider;

type WebhookRegistration = {
  route: { accountId?: string; auth?: string; handler?: LineNodeWebhookHandler };
  target: { accountId?: string; path: string };
};

function requireWebhookRegistration(): WebhookRegistration {
  const registration = registerWebhookTargetWithPluginRouteMock.mock.calls[0]?.[0] as
    | WebhookRegistration
    | undefined;
  return expectDefined(registration, "registered LINE webhook target");
}

function requireRegisteredRoute(): { handler: LineNodeWebhookHandler } {
  return {
    handler: expectDefined(requireWebhookRegistration().route.handler, "LINE webhook route"),
  };
}

function requireBot(index = 0) {
  return expectDefined(createLineBotMock.mock.results[index]?.value, "registered LINE webhook bot");
}

// mock-isolation: Drive lifecycle with the fixture-owned bot instead of starting a LINE client.
vi.mock("./bot.js", () => ({ createLineBot: createLineBotMock }));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
    danger: (value: unknown) => String(value),
    logVerbose: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>()),
    registerWebhookTargetWithPluginRoute: registerWebhookTargetWithPluginRouteMock,
  };
});

// mock-isolation: Observe dispatch without sending through a real LINE client.
vi.mock("./auto-reply-delivery.js", () => ({ deliverLineAutoReply: vi.fn() }));

function startMonitor(options: Partial<Parameters<typeof monitorLineProvider>[0]> = {}) {
  return monitorLineProvider({
    channelAccessToken: "token",
    channelSecret: "secret", // pragma: allowlist secret
    config: {},
    runtime: {} as RuntimeEnv,
    ...options,
  });
}

type OnMessage = LineBotOptions["onMessage"];
type InboundFixture = Partial<
  Pick<Parameters<OnMessage>[0], "replyToken" | "isGroup" | "userId" | "skillFilter">
> & { from?: string; body?: string; agentId?: string; sessionKey?: string };
function dispatchInbound(
  {
    from = "line:U1",
    body = "hi",
    agentId = "main",
    sessionKey = "line:C1",
    ...input
  }: InboundFixture,
  cfg: OpenClawConfig = {},
) {
  const onMessage = expectDefined(
    createLineBotMock.mock.calls[0]?.[0]?.onMessage,
    "LINE inbound handler",
  );
  return onMessage(
    {
      ctxPayload: { From: from, MessageSid: "m1", RawBody: body },
      route: { accountId: "default", agentId, sessionKey },
      isGroup: false,
      accountId: "default",
      turn: { record: {} },
      ...input,
    } as Parameters<OnMessage>[0],
    { cfg } as Parameters<OnMessage>[1],
  );
}

async function captureTurn() {
  const { setLineRuntime } = await import("./runtime.js");
  let resolved: ChannelInboundTurnPlan | undefined;
  setLineRuntime({
    channel: {
      inbound: {
        run: async (params: { adapter: { resolveTurn: () => ChannelInboundTurnPlan } }) => {
          resolved = params.adapter.resolveTurn();
          return { dispatched: false };
        },
      },
    },
  } as unknown as Parameters<typeof setLineRuntime>[0]);
  return () => resolved;
}

const webhookPayload = JSON.stringify({ events: [{ type: "message" }] });
const directUserId = "U0123456789abcdef0123456789abcdef";
const sign = (body: string, secret = "secret") =>
  crypto.createHmac("SHA256", secret).update(body).digest("base64");
function signedRequest(secret = "secret") {
  return Object.assign(createMockIncomingRequest([webhookPayload]), {
    method: "POST",
    headers: { "x-line-signature": sign(webhookPayload, secret) },
  }) as unknown as IncomingMessage;
}

async function expectWebhookResponse(
  response: Response,
  status: number,
  body: unknown,
  marker: string | null = null,
) {
  expect({
    status: response.status,
    marker: response.headers.get("x-openclaw-delivery-accepted"),
    body: await response.json(),
  }).toEqual({ status, marker, body });
}

describe("monitorLineProvider lifecycle", () => {
  beforeAll(async () => {
    ({ monitorLineProvider } = await import("./monitor.js"));
  });

  afterAll(() => {
    vi.doUnmock("./bot.js");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
    vi.doUnmock("./auto-reply-delivery.js");
    vi.resetModules();
  });

  beforeEach(() => {
    createLineBotMock.mockClear();
    unregisterHttpMock.mockReset();
    registerWebhookTargetWithPluginRouteMock.mockReset().mockImplementation((params) => {
      const withLeadingSlash = params.target.path.startsWith("/")
        ? params.target.path
        : `/${params.target.path}`;
      const key =
        withLeadingSlash
          .replace(/\/{2,}/g, "/")
          .replace(/\/+$/, "")
          .toLowerCase() || "/";
      const normalizedTarget = { ...params.target, path: key };
      const existing = params.targetsByPath.get(key) ?? [];
      params.targetsByPath.set(key, [...existing, normalizedTarget]);
      return {
        target: normalizedTarget,
        unregister: () => {
          unregisterHttpMock();
          const updated = (params.targetsByPath.get(key) ?? []).filter(
            (entry: unknown) => entry !== normalizedTarget,
          );
          if (updated.length > 0) {
            params.targetsByPath.set(key, updated);
          } else {
            params.targetsByPath.delete(key);
          }
        },
      };
    });
  });

  const createRouteResponse = () => {
    const resObj = {
      statusCode: 0,
      headersSent: false,
      setHeader: vi.fn(),
      end: vi.fn(() => {
        resObj.headersSent = true;
      }),
    };
    return resObj as unknown as ServerResponse & { end: ReturnType<typeof vi.fn> };
  };

  it("waits for abort before resolving", async () => {
    const abort = new AbortController();
    const statusSink = vi.fn();
    let resolved = false;

    const task = startMonitor({
      abortSignal: abort.signal,
      statusSink,
    }).then((monitor) => {
      resolved = true;
      return monitor;
    });

    expect(registerWebhookTargetWithPluginRouteMock).toHaveBeenCalledTimes(1);
    expect(requireWebhookRegistration().route.auth).toBe("plugin");
    await vi.waitFor(() =>
      expect(statusSink).toHaveBeenCalledWith(
        expect.objectContaining({ lifecycle: "ready", connected: true }),
      ),
    );
    expect(resolved).toBe(false);

    abort.abort();
    await task;
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
    expect(statusSink).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: "stopped", running: false }),
    );
  });

  it("rejects a blank channel secret before creating a bot or registering a route", async () => {
    await expect(startMonitor({ channelSecret: "  " })).rejects.toThrow(/non-empty channel secret/);
    expect(createLineBotMock).not.toHaveBeenCalled();
    expect(registerWebhookTargetWithPluginRouteMock).not.toHaveBeenCalled();
  });

  it("stops immediately when signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    await startMonitor({
      abortSignal: abort.signal,
    });

    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("registers the configured defaultAccount when accountId is omitted", async () => {
    const monitor = await startMonitor({
      config: { channels: { line: { defaultAccount: "work", accounts: { work: {} } } } },
    });

    expect(requireWebhookRegistration()).toMatchObject({
      target: { accountId: "work" },
      route: { accountId: "work" },
    });

    await monitor.stop();
  });

  it("stops the bot and rejects startup when the webhook route cannot bind", async () => {
    const statusSink = vi.fn();
    registerWebhookTargetWithPluginRouteMock.mockImplementationOnce(() => {
      throw new Error("LINE route conflict");
    });

    await expect(
      startMonitor({
        statusSink,
      }),
    ).rejects.toThrow("LINE route conflict");

    expect(requireBot().stop).toHaveBeenCalledOnce();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });

  it.each([
    [`line:${directUserId}`, true, true, true],
    [`line:${directUserId}`, true, false, false],
    ["unknown", true, true, false],
    ["line:group:C0123456789abcdef0123456789abcdef", false, false, true],
  ] as const)(
    "prepares replies for %s (question=%s, prompt=%s, native=%s)",
    async (from, question, prompt, native) => {
      const resolvedTurn = await captureTurn();
      const monitor = await startMonitor();

      try {
        await dispatchInbound({
          from,
          body: "approve?",
          replyToken: "reply-token",
          isGroup: !from.startsWith("line:U"),
        });

        const questionId = "ask_3d8dbe55be452a9a39add7c909beb119";
        const prepared = await resolvedTurn()?.delivery.preparePayload?.(
          {
            text: "Approve this run? Approve / Deny",
            presentationTextMode: "fallback",
            ...(question
              ? { channelData: { askUser: { questionId, optionValues: ["Approve", "Deny"] } } }
              : {}),
            presentation: {
              blocks: [
                ...(prompt ? [{ type: "text" as const, text: "Approve this run?" }] : []),
                {
                  type: "buttons",
                  buttons: question
                    ? ["Approve", "Deny"].map((label) => ({
                        label,
                        action: { type: "question" as const, questionId, optionValue: label },
                      }))
                    : [{ label: "Approve", action: { type: "callback", value: "approve" } }],
                },
              ],
            },
          },
          { kind: "final" },
        );
        const line = prepared?.channelData?.line as { flexMessage?: unknown } | undefined;

        expect(prepared?.presentation).toBeUndefined();
        if (native) {
          expect(line?.flexMessage).toBeDefined();
          if (question) {
            expect(line?.flexMessage).toMatchObject({
              contents: {
                footer: {
                  contents: [
                    { action: { data: `line.question=${questionId}&line.option=0` } },
                    { action: { data: `line.question=${questionId}&line.option=1` } },
                  ],
                },
              },
            });
          }
        } else {
          expect(line).toBeUndefined();
          expect(prepared?.text).toBe("Approve this run? Approve / Deny");
        }
      } finally {
        await monitor.stop();
      }
    },
  );

  it("refreshes direct-chat loading until a failed inbound turn settles", async () => {
    const { messagingApi } = await import("@line/bot-sdk");
    const { setLineRuntime } = await import("./runtime.js");
    const entered = createDeferred<void>();
    const finished = createDeferred<void>();
    const loading = vi
      .spyOn(messagingApi.MessagingApiClient.prototype, "showLoadingAnimation")
      .mockResolvedValue({});
    setLineRuntime({
      channel: {
        inbound: {
          run: async () => {
            entered.resolve();
            await finished.promise;
            throw new Error("turn failed");
          },
        },
      },
    } as unknown as Parameters<typeof setLineRuntime>[0]);
    const monitor = await startMonitor();
    vi.useFakeTimers();
    const task = dispatchInbound(
      { from: `line:${directUserId}`, sessionKey: `line:${directUserId}`, userId: directUserId },
      { channels: { line: { channelAccessToken: "token" } } },
    );
    try {
      await entered.promise;
      expect(loading).toHaveBeenCalledWith({
        chatId: directUserId,
        loadingSeconds: 20,
      });
      await vi.advanceTimersByTimeAsync(18_000);
      expect(loading).toHaveBeenCalledTimes(2);
      finished.resolve();
      await expect(task).rejects.toThrow("turn failed");
      await vi.advanceTimersByTimeAsync(18_000);
      expect(loading).toHaveBeenCalledTimes(2);
    } finally {
      finished.resolve();
      await Promise.resolve(task).catch(() => {});
      await monitor.stop();
      loading.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each<[string, InboundFixture, OpenClawConfig, unknown]>([
    [
      "dispatcherOptions.humanDelay",
      { replyToken: "reply-token", agentId: "ops", sessionKey: "line:U1" },
      {
        agents: {
          defaults: { humanDelay: { mode: "natural" } },
          entries: { ops: { humanDelay: { mode: "custom", minMs: 3_000, maxMs: 4_000 } } },
        },
      },
      { mode: "custom", minMs: 3_000, maxMs: 4_000 },
    ],
    [
      "replyOptions.skillFilter",
      { from: "line:group:C1", isGroup: true, skillFilter: ["triage"] },
      {},
      ["triage"],
    ],
  ])("carries %s into the turn", async (path, input, cfg, expected) => {
    const resolvedTurn = await captureTurn();
    const monitor = await startMonitor();
    try {
      await dispatchInbound(input, cfg);
      expect(resolvedTurn()).toHaveProperty(path, expected);
    } finally {
      await monitor.stop();
    }
  });

  it("dispatches shared-path webhook posts to the account matching the signature", async () => {
    const firstMonitor = await startMonitor({
      channelSecret: "first-secret", // pragma: allowlist secret
      accountId: "first",
      webhookPath: "/Line//Webhook/",
    });
    const secondMonitor = await startMonitor({
      channelSecret: "second-secret", // pragma: allowlist secret
      accountId: "second",
    });

    const registration = requireWebhookRegistration();
    expect(registration.target).toMatchObject({ path: "/Line//Webhook", accountId: "first" });
    expect(registration.route).toMatchObject({
      accountId: "first",
      auth: "plugin",
      pluginId: "line",
      source: "line-webhook",
      throwOnFailure: true,
    });
    expect(registration.route).not.toHaveProperty("path");
    expect(registration.route).not.toHaveProperty("replaceExisting");

    const route = requireRegisteredRoute();

    const res = createRouteResponse();

    await route.handler(signedRequest("second-secret"), res);

    expect(res.statusCode).toBe(200);
    expect(requireBot().handleWebhook).not.toHaveBeenCalled();
    expect(requireBot(1).handleWebhook).toHaveBeenCalledTimes(1);

    await firstMonitor.stop();
    await secondMonitor.stop();
  });

  it("marks only durably admitted signed HTTP webhooks and redacts failures", async () => {
    const runtimeError = vi.fn<(...args: unknown[]) => void>();
    const runtime: RuntimeEnv = {
      log: vi.fn<(...args: unknown[]) => void>(),
      error: runtimeError,
      exit: vi.fn<(code: number) => void>(),
    };
    const monitor = await startMonitor({
      accountId: "default",
      runtime,
    });
    const route = requireRegisteredRoute();
    try {
      await withServer(
        (req, res) => {
          void route.handler(req, res);
        },
        async (baseUrl) => {
          const webhookUrl = `${baseUrl}/line/webhook`;
          const post = (body = webhookPayload, signature = sign(body)) =>
            fetch(webhookUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-line-signature": signature,
              },
              body,
            });
          const rejected = await post(webhookPayload, "invalid-signature");
          await expectWebhookResponse(rejected, 401, { error: "Invalid signature" });

          const bot = requireBot();
          expect(bot.handleWebhook).not.toHaveBeenCalled();

          const verificationPayload = JSON.stringify({ events: [] });
          const verification = await post(verificationPayload);
          await expectWebhookResponse(verification, 200, { status: "ok" });
          expect(bot.handleWebhook).not.toHaveBeenCalled();

          const admission = createDeferred<Awaited<ReturnType<LineHandleWebhook>>>();
          bot.handleWebhook.mockReturnValueOnce(admission.promise);
          let acceptedResponseReceived = false;
          const acceptedRequest = post().then((response) => {
            acceptedResponseReceived = true;
            return response;
          });
          await vi.waitFor(() => {
            expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
          });
          expect(acceptedResponseReceived).toBe(false);
          admission.resolve("durable");
          const accepted = await acceptedRequest;
          await expectWebhookResponse(accepted, 200, { status: "ok" }, "durable");

          const bearerToken = "test_line_access_token_1234567890";
          bot.handleWebhook.mockRejectedValueOnce({
            code: "LINE_ADMISSION_REJECTED",
            retryAfterMs: 250,
            authorization: `Bearer ${bearerToken}`,
          });
          const response = await post();

          await expectWebhookResponse(response, 500, { error: "Internal server error" });
          expect(bot.handleWebhook).toHaveBeenCalledTimes(2);
          expect(runtimeError).toHaveBeenCalledTimes(1);
          const message = String(runtimeError.mock.calls[0]?.[0]);
          expect(message).toContain("line webhook error:");
          expect(message).toContain("LINE_ADMISSION_REJECTED");
          expect(message).toContain("retryAfterMs");
          expect(message).not.toContain("[object Object]");
          expect(message).not.toContain(bearerToken);

          // Keep the HTTP receipt tied to the real queue, including deliberate non-admission.
          await withQueue(async (queue) => {
            const delivered: webhook.Event[] = [];
            const spool = createLineWebhookSpool({
              accountId: "default",
              runtime,
              queue,
              deliver: async (events, _destination, control) => {
                delivered.push(...events);
                await control.turnAdoptionLifecycle.onAdopted();
              },
            });
            bot.handleWebhook.mockImplementation(spool.accept);
            const active = createEvent({ webhookEventId: "receipt-active" });
            const standby = createEvent({ webhookEventId: "receipt-standby", mode: "standby" });
            const common = {
              mode: "standby" as const,
              timestamp: Date.now(),
              deliveryContext: { isRedelivery: false },
            };
            const postback: webhook.Event = {
              ...common,
              type: "postback",
              webhookEventId: "receipt-postback",
              source: { type: "user", userId: "user-standby" },
              postback: { data: "continue" },
            };
            const join = {
              ...common,
              type: "join",
              webhookEventId: "receipt-join",
              source: { type: "group", groupId: "group-standby" },
            };
            try {
              for (const [events, expectedIds, marker] of [
                [[standby, postback, join], [], null],
                [[standby, active], ["message:message-receipt-active"], "durable"],
                [[active], ["message:message-receipt-active"], "durable"],
              ] as const) {
                const body = JSON.stringify({ destination: "fixture-bot", events });
                const admittedResponse = await post(body);
                expect((await queue.listPending()).map((entry) => entry.id)).toEqual(expectedIds);
                await expectWebhookResponse(admittedResponse, 200, { status: "ok" }, marker);
              }
              spool.start();
              await vi.waitFor(() => expect(delivered).toEqual([active]));
            } finally {
              await spool.stop();
            }
          });
        },
      );
    } finally {
      await monitor.stop();
    }
  });

  it("rejects ambiguous shared-path webhook signatures", async () => {
    const firstMonitor = await startMonitor({
      channelSecret: "shared-secret", // pragma: allowlist secret
      accountId: "first",
    });
    const secondMonitor = await startMonitor({
      channelSecret: "shared-secret", // pragma: allowlist secret
      accountId: "second",
    });

    const route = requireRegisteredRoute();

    const res = createRouteResponse();

    await route.handler(signedRequest("shared-secret"), res);

    expect(res.statusCode).toBe(401);
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Ambiguous webhook target" }));
    expect(requireBot().handleWebhook).not.toHaveBeenCalled();
    expect(requireBot(1).handleWebhook).not.toHaveBeenCalled();

    await firstMonitor.stop();
    await secondMonitor.stop();
  });

  it("rejects webhook requests above the shared in-flight limit before body handling", async () => {
    const limit = WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey;
    const heldRequests: IncomingMessage[] = [];

    const monitor = await startMonitor();

    const route = requireRegisteredRoute();
    const createHeldPostRequest = () => {
      const req = new IncomingMessage(new Socket());
      heldRequests.push(req);
      return Object.assign(req, {
        method: "POST",
        headers: { "x-line-signature": "pending" },
      }) as unknown as IncomingMessage;
    };

    const firstRequests = Array.from({ length: limit }, () =>
      route.handler(createHeldPostRequest(), createRouteResponse()),
    );
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    const overflowResponse = createRouteResponse();
    await route.handler(signedRequest(), overflowResponse);

    expect(requireBot().handleWebhook).not.toHaveBeenCalled();
    expect(overflowResponse.statusCode).toBe(429);
    expect(overflowResponse.end).toHaveBeenCalledWith("Too Many Requests");

    heldRequests.splice(0).forEach((req) => req.destroy());
    await Promise.allSettled(firstRequests);
    await monitor.stop();
  });
});
