// Real webhook, reply dispatcher, OAuth, and Google HTTP transport.
// Authorization/admission and model execution are simulated to keep the fixture isolated.
import { generateKeyPairSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import {
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatIngressLifecycle } from "./monitor-ingress.js";
import type { GoogleChatCoreRuntime, WebhookTarget } from "./monitor-types.js";
import { createGoogleChatWebhookRequestHandler } from "./monitor-webhook.js";
import type { GoogleChatEvent } from "./types.js";
import "./monitor.js";

const mocks = vi.hoisted(() => ({
  processEvent: undefined as
    | ((
        event: GoogleChatEvent,
        target: WebhookTarget,
        lifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>)
    | undefined,
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  verifyGoogleChatRequest: vi.fn(async () => ({ ok: true as const })),
}));
// mock-isolation: Pairing and access policy state are outside this delivery lifecycle proof.
vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: async () => ({ ok: true }),
}));
// mock-isolation: Capture the event processor without installing global webhook targets.
vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: (processEvent: NonNullable<typeof mocks.processEvent>) => {
    mocks.processEvent = processEvent;
  },
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  createChannelInboundEnvelopeBuilderAsync:
    async () =>
    ({ body }: { body: string }) =>
      body,
}));
vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: ({ accountId }: { accountId: string }) => ({
    agentId: "agent-1",
    accountId,
    sessionKey: "session-1",
  }),
}));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const typingName = "spaces/AAA/messages/typing";
const answer = "Visible assistant answer";
type Mode = "silent" | "failed" | "visible" | "deferred-silent" | "deferred-visible";
type TurnArgs = {
  turnAdoptionLifecycle?: Parameters<
    GoogleChatCoreRuntime["channel"]["inbound"]["run"]
  >[0]["turnAdoptionLifecycle"];
  adapter: { resolveTurn: () => ChannelInboundTurnPlan | Promise<ChannelInboundTurnPlan> };
};
type RequestRecord = { method: string; pathname: string; text?: string };

function googleStub(invalidPatchResponse: boolean) {
  const requests: RequestRecord[] = [];
  let messageText: string | undefined;
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const pathname = new URL(request.url ?? "/", "http://stub.invalid").pathname;
      const json = (payload: unknown) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(payload));
      };
      if (pathname === "/token") {
        json({ access_token: "ya29.synthetic", token_type: "Bearer", expires_in: 3600 });
        return;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = body ? (JSON.parse(body) as { text?: string }) : {};
      requests.push({
        method: request.method ?? "",
        pathname,
        ...(payload.text ? { text: payload.text } : {}),
      });
      if (request.method === "DELETE") {
        messageText = undefined;
        response.writeHead(204).end();
      } else if (request.method === "PATCH") {
        // The mutation succeeds but the caller cannot decode its response.
        messageText = payload.text;
        if (invalidPatchResponse) {
          response.setHeader("Content-Type", "application/json");
          response.end("{");
        } else {
          json({ name: typingName });
        }
      } else {
        if (payload.text === "_OpenClaw is typing..._") {
          messageText = payload.text;
        }
        json({
          name:
            payload.text === "_OpenClaw is typing..._" ? typingName : "spaces/AAA/messages/second",
        });
      }
    });
  };
  return { handler, requests, getMessageText: () => messageText };
}

async function runWebhookTurn(
  mode: Mode,
  options: { invalidPatchResponse?: boolean; withIngressLifecycle?: boolean } = {},
) {
  const account: ResolvedGoogleChatAccount = {
    accountId: `typing-${mode}`,
    enabled: true,
    credentialSource: "inline",
    credentials: {
      type: "service_account",
      client_email: "stub@stub-project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    },
    config: { typingIndicator: "message" },
  };
  const stub = googleStub(options.invalidPatchResponse ?? false);
  const errors: string[] = [];
  let accepted: boolean | undefined;
  let failedDeliveries = 0;
  let resumeDeferred: (() => Promise<void>) | undefined;
  let requestsBeforeResume: RequestRecord[] | undefined;
  const lifecycle: GoogleChatIngressLifecycle = {
    admission: "exclusive",
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(),
    onDeferred: vi.fn(),
    onAbandoned: vi.fn(),
  };
  const run = async ({ adapter, turnAdoptionLifecycle }: TurnArgs) => {
    if (mode === "failed") {
      await turnAdoptionLifecycle?.onSettled?.();
      throw new Error("model turn failed");
    }
    const { delivery } = await adapter.resolveTurn();
    const dispatch = async () => {
      const dispatcher = createReplyDispatcher({
        deliver: async (payload, info) => {
          await delivery.deliver(payload, info);
        },
        onError: (error) => {
          errors.push(String(error));
        },
      });
      try {
        accepted = dispatcher.sendFinalReply(
          mode.endsWith("silent")
            ? setReplyPayloadMetadata({ text: "NO_REPLY" }, { silentReply: true })
            : { text: answer },
        );
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        failedDeliveries = dispatcher.getFailedCounts().final;
      }
    };
    if (mode.startsWith("deferred-")) {
      turnAdoptionLifecycle?.onDeferred?.();
      resumeDeferred = async () => {
        try {
          await turnAdoptionLifecycle?.onAdopted();
          await dispatch();
        } finally {
          await turnAdoptionLifecycle?.onSettled?.();
        }
      };
      return;
    }
    // The agent lifecycle settles before dispatch finalizes its buffered reply.
    await turnAdoptionLifecycle?.onSettled?.();
    await dispatch();
  };
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { buildContext: (value: unknown) => value, run },
      text: {
        resolveChunkMode: () => "markdown",
        chunkMarkdownTextWithMode: () => [answer, "Second chunk"],
      },
    },
  } as unknown as GoogleChatCoreRuntime;
  const realFetch = globalThis.fetch;
  let googleBaseUrl = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return await realFetch(
        url.hostname === "chat.googleapis.com" || url.hostname === "oauth2.googleapis.com"
          ? `${googleBaseUrl}${url.pathname}${url.search}`
          : input,
        init,
      );
    }),
  );
  let webhookStatus = 0;
  await withServer(stub.handler, async (baseUrl) => {
    googleBaseUrl = baseUrl;
    const target: WebhookTarget = {
      account,
      config: {},
      core,
      runtime: { error: (line) => errors.push(line) },
      path: "/googlechat",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
      mediaMaxMb: 10,
      ingress: {
        receive: async (raw) => {
          if (!mocks.processEvent) {
            throw new Error("Expected registered event processor");
          }
          // Admission storage is outside this proof; dispatch the authenticated event immediately.
          await mocks.processEvent(
            raw as GoogleChatEvent,
            target,
            options.withIngressLifecycle === false ? undefined : lifecycle,
          );
          return { kind: "durable" as const };
        },
      },
    };
    const handler = createGoogleChatWebhookRequestHandler({
      webhookTargets: new Map([[target.path, [target]]]),
      webhookRateLimiter: createFixedWindowRateLimiter(WEBHOOK_RATE_LIMIT_DEFAULTS),
      webhookInFlightLimiter: createWebhookInFlightLimiter(),
      processEvent: async (event, eventTarget) => {
        await mocks.processEvent?.(event, eventTarget);
      },
    });
    await withServer(
      (request, response) => void handler(request, response),
      async (webhookUrl) => {
        const response = await fetch(`${webhookUrl}/googlechat`, {
          method: "POST",
          headers: {
            Authorization: "Bearer synthetic-webhook-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "MESSAGE",
            space: { name: "spaces/AAA", type: "DM" },
            message: {
              name: "spaces/AAA/messages/inbound",
              text: "Hello",
              sender: { name: "users/alice", type: "HUMAN" },
            },
          } satisfies GoogleChatEvent),
        });
        webhookStatus = response.status;
        await response.text();
        if (resumeDeferred) {
          requestsBeforeResume = structuredClone(stub.requests);
          await resumeDeferred();
        }
      },
    );
  });
  return { ...stub, errors, accepted, failedDeliveries, requestsBeforeResume, webhookStatus };
}

afterEach(() => vi.unstubAllGlobals());

describe("Google Chat typing cleanup through the webhook and HTTP transport", () => {
  it("keeps the placeholder for a buffered reply after the immediate agent lifecycle settles", async () => {
    const result = await runWebhookTurn("visible");
    expect(result.webhookStatus).toBe(200);
    expect(result.requests).toEqual([
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
      { method: "PATCH", pathname: `/v1/${typingName}`, text: answer },
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "Second chunk" },
    ]);
    expect(result.getMessageText()).toBe(answer);
  });

  it.each(["silent", "failed"] as const)("cleans the placeholder after a %s turn", async (mode) => {
    const result = await runWebhookTurn(mode);
    expect(result.webhookStatus).toBe(mode === "failed" ? 503 : 200);
    expect(result.requests).toEqual([
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
      { method: "DELETE", pathname: `/v1/${typingName}` },
    ]);
    expect(result.getMessageText()).toBeUndefined();
    if (mode === "silent") {
      expect(result.accepted).toBe(false);
    }
  });

  it.each([
    { mode: "deferred-silent" as const, withIngressLifecycle: true },
    { mode: "deferred-visible" as const, withIngressLifecycle: true },
    { mode: "deferred-visible" as const, withIngressLifecycle: false },
  ])(
    "retains typing until $mode settles (ingress lifecycle=$withIngressLifecycle)",
    async ({ mode, withIngressLifecycle }) => {
      const result = await runWebhookTurn(mode, { withIngressLifecycle });
      const typing = {
        method: "POST",
        pathname: "/v1/spaces/AAA/messages",
        text: "_OpenClaw is typing..._",
      };
      expect(result.webhookStatus).toBe(200);
      expect(result.requestsBeforeResume).toEqual([typing]);
      expect(result.requests).toEqual(
        mode === "deferred-silent"
          ? [typing, { method: "DELETE", pathname: `/v1/${typingName}` }]
          : [
              typing,
              { method: "PATCH", pathname: `/v1/${typingName}`, text: answer },
              { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "Second chunk" },
            ],
      );
    },
  );

  it("preserves a possible answer after PATCH applied but its response failed", async () => {
    const result = await runWebhookTurn("visible", { invalidPatchResponse: true });
    expect(result.webhookStatus).toBe(200);
    expect(result.failedDeliveries).toBe(1);
    expect(result.requests.map(({ method }) => method)).toEqual(["POST", "PATCH"]);
    expect(result.getMessageText()).toBe(answer);
  });
});
