import fs from "node:fs";
import path from "node:path";
import {
  sendDurableMessageBatch,
  type ChannelMessageSendMediaContext,
  type ChannelMessageSendTextContext,
} from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  readQueuedDeliveryEntriesForTest,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  requestUrl,
  useAutoCleanupTempDirTracker,
  withStateDirEnv,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickClackPlugin } from "../channel-plugin-api.js";

const cfg = {
  channels: {
    clickclack: {
      accounts: {
        alpha: {
          baseUrl: "https://alpha.example",
          token: "fixture-alpha-token",
          workspace: "wsp_alpha",
        },
        beta: {
          baseUrl: "https://beta.example",
          token: "fixture-beta-token",
          workspace: "wsp_beta",
        },
      },
    },
  },
};

type Registration = "message" | "outbound";
type Account = "alpha" | "beta";
type HttpRequest = { url: string; init?: RequestInit };
type RequestStage = "dm" | "upload" | "message" | "attachment" | "reconciliation" | "upload lookup";

function senders(registration: Registration) {
  const text =
    registration === "message"
      ? clickClackPlugin.message?.send?.text
      : clickClackPlugin.outbound?.sendText;
  const media =
    registration === "message"
      ? clickClackPlugin.message?.send?.media
      : clickClackPlugin.outbound?.sendMedia;
  if (!text || !media) {
    throw new Error(`Missing ClickClack ${registration} sender`);
  }
  return {
    text: async (ctx: Omit<ChannelMessageSendTextContext, "onDeliveryResult">) => text(ctx),
    media: async (ctx: Omit<ChannelMessageSendMediaContext, "onDeliveryResult">) => media(ctx),
  };
}

function observe<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

function createAuthority() {
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new PlatformMessageNotDispatchedError("ClickClack sender retired", {
        cause: new Error("Source lifecycle closed"),
        retryable: false,
      });
    }
  };
  return {
    revoke: () => {
      current = false;
    },
    context: {
      assertDirectAdapterHandoff: assertCurrent,
      onPlatformSendDispatch: async () => assertCurrent(),
    },
  };
}

function createRequestGate() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  return {
    hold: async () => {
      entered.resolve();
      await release.promise;
    },
    release: release.resolve,
    entered: async (outcome: Promise<unknown>) => {
      await Promise.race([
        entered.promise,
        outcome.then(() => {
          throw new Error("Send settled before the expected request reached the transport");
        }),
      ]);
    },
  };
}

function installTransport(
  options: {
    beforeResponse?: (stage: RequestStage, account: Account) => Promise<void> | void;
    firstAttachmentFails?: boolean;
    reconciledAttachment?: boolean;
    reconciliationFails?: boolean;
  } = {},
) {
  const requests: HttpRequest[] = [];
  const attachmentAttempts = new Map<Account, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(requestUrl(input));
      const account = url.hostname.split(".")[0];
      if (account !== "alpha" && account !== "beta") {
        throw new Error(`Unexpected ClickClack host: ${url.host}`);
      }
      requests.push({ url: url.href, init });
      const method = init?.method ?? "GET";
      let stage: RequestStage;
      let response: () => Response;
      if (method === "POST" && url.pathname === "/api/dms") {
        stage = "dm";
        response = () => Response.json({ conversation: { id: `dcn_${account}` } }, { status: 201 });
      } else if (method === "GET" && url.pathname === "/api/uploads/by-nonce") {
        stage = "upload lookup";
        response = () =>
          new Response("Not found", {
            status: 404,
            headers: { "X-ClickClack-Upload-Nonce": "supported" },
          });
      } else if (method === "POST" && url.pathname === "/api/uploads") {
        stage = "upload";
        response = () =>
          Response.json(
            { upload: { id: `upl_${account}`, filename: "proof.txt" } },
            { status: 201 },
          );
      } else if (
        method === "POST" &&
        (url.pathname === `/api/dms/dcn_${account}/messages` ||
          url.pathname === `/api/channels/chn_${account}/messages`)
      ) {
        stage = "message";
        response = () => Response.json({ message: { id: `msg_${account}` } }, { status: 201 });
      } else if (method === "POST" && url.pathname === `/api/messages/msg_${account}/attachments`) {
        stage = "attachment";
        const attempt = (attachmentAttempts.get(account) ?? 0) + 1;
        attachmentAttempts.set(account, attempt);
        response = () => {
          if (options.firstAttachmentFails && attempt === 1) {
            throw new Error("First attachment response was lost");
          }
          return Response.json({ ok: true });
        };
      } else if (method === "GET" && url.pathname === `/api/messages/msg_${account}`) {
        stage = "reconciliation";
        response = () => {
          if (options.reconciliationFails) {
            throw new Error("Attachment reconciliation was unavailable");
          }
          return Response.json({
            message: {
              id: `msg_${account}`,
              attachments: options.reconciledAttachment ? [{ id: `upl_${account}` }] : [],
            },
          });
        };
      } else {
        throw new Error(`Unexpected ClickClack request: ${method} ${url.href}`);
      }
      await options.beforeResponse?.(stage, account);
      return response();
    }),
  );
  return requests;
}

function requestPaths(requests: HttpRequest[]) {
  return requests.map(({ url, init }) => `${init?.method ?? "GET"} ${new URL(url).pathname}`);
}

function expectAccountRequests(requests: HttpRequest[], account: Account) {
  for (const { url, init } of requests) {
    expect(new URL(url).origin).toBe(`https://${account}.example`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer fixture-${account}-token`);
  }
}

function jsonBody(request: HttpRequest | undefined): unknown {
  const body = request?.init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON ClickClack request body");
  }
  return JSON.parse(body);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createMedia() {
  const directory = fs.realpathSync(tempDirs.make("clickclack-sender-"));
  const mediaUrl = path.join(directory, "proof.txt");
  fs.writeFileSync(mediaUrl, "A retained attachment.");
  return { mediaUrl, mediaLocalRoots: [directory] };
}

function mediaContext() {
  return {
    cfg,
    accountId: "alpha",
    to: "channel:chn_alpha",
    text: "A file reply",
    ...createMedia(),
  };
}

async function withDeferredResponse<T>(
  stage: RequestStage,
  state: "active" | "revoked",
  send: (context: ReturnType<typeof createAuthority>["context"]) => Promise<T>,
  options: Omit<NonNullable<Parameters<typeof installTransport>[0]>, "beforeResponse"> = {},
) {
  const gate = createRequestGate();
  const requests = installTransport({
    ...options,
    beforeResponse: (current) => (current === stage ? gate.hold() : undefined),
  });
  const authority = createAuthority();
  const outcome = observe(send(authority.context));
  try {
    await gate.entered(outcome);
    if (state === "revoked") {
      authority.revoke();
    }
    gate.release();
    const result = await outcome;
    expectAccountRequests(requests, "alpha");
    return { result, requests };
  } finally {
    gate.release();
    await outcome;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("ClickClack sender authority", () => {
  it("stops the outbound sender after a deferred upload is revoked", async () => {
    const { result, requests } = await withDeferredResponse("upload", "revoked", (context) =>
      senders("outbound").media({ ...mediaContext(), ...context }),
    );
    expect(result).toMatchObject({
      status: "rejected",
      error: { message: expect.stringContaining("sender retired") },
    });
    expect(requestPaths(requests)).toEqual(["POST /api/uploads"]);
  });

  it.each(["active", "revoked"] as const)(
    "preserves %s authority after attachment reconciliation",
    async (state) => {
      const { result, requests } = await withDeferredResponse(
        "reconciliation",
        state,
        (context) => senders("message").media({ ...mediaContext(), ...context }),
        { firstAttachmentFails: true, reconciliationFails: state === "active" },
      );
      expect(result).toMatchObject(
        state === "active"
          ? { status: "fulfilled", value: { messageId: "msg_alpha" } }
          : {
              status: "rejected",
              error: {
                message: expect.stringContaining("sender retired"),
                sentBeforeError: true,
                deliveryResult: {
                  visibleReplySent: true,
                  messageIds: ["msg_alpha"],
                  receipt: { parts: [{ platformMessageId: "msg_alpha", kind: "text" }] },
                },
              },
            },
      );
      expect(requestPaths(requests)).toEqual([
        "POST /api/uploads",
        "POST /api/channels/chn_alpha/messages",
        "POST /api/messages/msg_alpha/attachments",
        "GET /api/messages/msg_alpha",
        ...(state === "active" ? ["POST /api/messages/msg_alpha/attachments"] : []),
      ]);
      expect(jsonBody(requests[2])).toEqual({ upload_id: "upl_alpha" });
      if (state === "active") {
        expect(jsonBody(requests[4])).toEqual({ upload_id: "upl_alpha" });
      }
    },
  );

  it.each(["attachment", "reconciliation"] as const)(
    "settles accepted %s success after the sender closes",
    async (stage) => {
      const { result, requests } = await withDeferredResponse(
        stage,
        "revoked",
        (context) => senders("outbound").media({ ...mediaContext(), ...context }),
        { firstAttachmentFails: stage === "reconciliation", reconciledAttachment: true },
      );
      expect(result).toMatchObject({ status: "fulfilled", value: { messageId: "msg_alpha" } });
      expect(requestPaths(requests)).toEqual([
        "POST /api/uploads",
        "POST /api/channels/chn_alpha/messages",
        "POST /api/messages/msg_alpha/attachments",
        ...(stage === "reconciliation" ? ["GET /api/messages/msg_alpha"] : []),
      ]);
    },
  );
});

it.each([
  ["message", "outbound"],
  ["outbound", "message"],
] as const)(
  "keeps a revoked %s sender independent from an active %s account",
  async (revoked, active) => {
    const gates = { alpha: createRequestGate(), beta: createRequestGate() };
    const requests = installTransport({
      beforeResponse: (stage, account) => (stage === "dm" ? gates[account].hold() : undefined),
    });
    const alpha = createAuthority();
    const beta = createAuthority();
    const first = observe(
      senders(revoked).text({
        cfg,
        accountId: "alpha",
        to: "dm:usr_alpha",
        text: "Alpha reply",
        ...alpha.context,
      }),
    );
    const second = observe(
      senders(active).text({
        cfg,
        accountId: "beta",
        to: "dm:usr_beta",
        text: "Beta reply",
        replyToId: "msg_quote",
        ...beta.context,
      }),
    );
    try {
      await Promise.all([gates.alpha.entered(first), gates.beta.entered(second)]);
      alpha.revoke();
      gates.alpha.release();
      expect(await first).toMatchObject({
        status: "rejected",
        error: { message: expect.stringContaining("sender retired") },
      });
      gates.beta.release();
      expect(await second).toMatchObject({ status: "fulfilled", value: { messageId: "msg_beta" } });
      const alphaRequests = requests.filter(({ url }) => new URL(url).hostname === "alpha.example");
      const betaRequests = requests.filter(({ url }) => new URL(url).hostname === "beta.example");
      expectAccountRequests(alphaRequests, "alpha");
      expectAccountRequests(betaRequests, "beta");
      expect(requestPaths(alphaRequests)).toEqual(["POST /api/dms"]);
      expect(requestPaths(betaRequests)).toEqual([
        "POST /api/dms",
        "POST /api/dms/dcn_beta/messages",
      ]);
      expect(jsonBody(alphaRequests[0])).toEqual({
        workspace_id: "wsp_alpha",
        member_ids: ["usr_alpha"],
      });
      expect(jsonBody(betaRequests[0])).toEqual({
        workspace_id: "wsp_beta",
        member_ids: ["usr_beta"],
      });
      expect(jsonBody(betaRequests[1])).toEqual({
        body: "Beta reply",
        quoted_message_id: "msg_quote",
      });
    } finally {
      gates.alpha.release();
      gates.beta.release();
      await Promise.all([first, second]);
    }
  },
);

it("reports the legacy accepted text identity before a later attachment is revoked", async () => {
  const sender = clickClackPlugin.outbound?.sendMedia;
  if (!sender) {
    throw new Error("Missing ClickClack legacy media sender");
  }
  const requests = installTransport();
  const authority = createAuthority();
  const progress: unknown[] = [];
  const result = await observe(
    sender({
      ...mediaContext(),
      ...authority.context,
      onDeliveryResult: (delivery) => {
        progress.push(delivery);
        authority.revoke();
      },
    }),
  );
  expect(progress).toMatchObject([
    {
      channel: "clickclack",
      messageId: "msg_alpha",
      receipt: { parts: [{ platformMessageId: "msg_alpha", kind: "text" }] },
    },
  ]);
  expect(progress).toHaveLength(1);
  expect(result).toMatchObject({
    status: "rejected",
    error: { sentBeforeError: true, deliveryResult: { messageIds: ["msg_alpha"] } },
  });
  expect(requestPaths(requests)).toEqual([
    "POST /api/uploads",
    "POST /api/channels/chn_alpha/messages",
  ]);
});

it.each(["active", "revoked"] as const)(
  "preserves the accepted message and durable custody with an %s sender",
  async (state) => {
    await withStateDirEnv("clickclack-sender-custody-", async ({ stateDir }) => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "clickclack", plugin: clickClackPlugin, source: "test" }]),
      );
      const media = createMedia();
      const { result, requests } = await withDeferredResponse("message", state, (context) =>
        sendDurableMessageBatch({
          cfg,
          channel: "clickclack",
          accountId: "alpha",
          to: "channel:chn_alpha",
          payloads: [{ text: "A file reply", mediaUrl: media.mediaUrl }],
          mediaAccess: { localRoots: media.mediaLocalRoots },
          durability: "required",
          deliveryIntentId: "clickclack-accepted-text",
          replyToId: "msg_quote",
          requireUnknownSendReconciliation: true,
          ...context,
        }),
      );
      if (result.status !== "fulfilled") {
        throw result.error;
      }
      const send = result.value;
      expect(send).toMatchObject({
        status: state === "active" ? "sent" : "partial_failed",
        results: [
          {
            channel: "clickclack",
            messageId: "msg_alpha",
            receipt: {
              parts: [
                { platformMessageId: "msg_alpha", kind: state === "active" ? "media" : "text" },
              ],
            },
          },
        ],
      });
      if (send.status !== "sent" && send.status !== "partial_failed") {
        throw new Error(`Expected an identified delivery, got ${send.status}`);
      }
      expect(send.results).toHaveLength(1);
      expect(send.receipt.platformMessageIds).toEqual(["msg_alpha"]);
      const queued = readQueuedDeliveryEntriesForTest(stateDir);
      if (state === "revoked") {
        expect(send).toMatchObject({
          sentBeforeError: true,
          error: { queueCustody: "held", sentBeforeError: true },
        });
        expect(queued).toMatchObject([
          {
            id: "clickclack-accepted-text",
            channel: "clickclack",
            accountId: "alpha",
            recoveryState: "unknown_after_send",
          },
        ]);
        expect(queued).toHaveLength(1);
      } else {
        expect(queued).toEqual([]);
      }
      expect(requestPaths(requests)).toEqual([
        "GET /api/uploads/by-nonce",
        "POST /api/uploads",
        "POST /api/channels/chn_alpha/messages",
        ...(state === "active" ? ["POST /api/messages/msg_alpha/attachments"] : []),
      ]);
      expect(jsonBody(requests[2])).toMatchObject({
        body: "A file reply",
        quoted_message_id: "msg_quote",
      });
    });
  },
);
