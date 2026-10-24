import fs from "node:fs";
import path from "node:path";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
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
    clickclack: { accounts: { alpha: accountConfig("alpha"), beta: accountConfig("beta") } },
  },
};

type Account = "alpha" | "beta";
type HttpRequest = { url: string; init?: RequestInit; body: unknown };
type RequestStage = "dm" | "upload" | "message" | "attachment" | "reconciliation" | "upload lookup";

function accountConfig(account: Account) {
  return {
    baseUrl: `https://${account}.example`,
    token: `fixture-${account}-token`,
    workspace: `wsp_${account}`,
  };
}

const uploadPath = "POST /api/uploads";
const messagePath = "POST /api/channels/chn_alpha/messages";
const attachmentPath = "POST /api/messages/msg_alpha/attachments";
const reconciliationPath = "GET /api/messages/msg_alpha";
const mediaPaths = [uploadPath, messagePath, attachmentPath];
function expectedDelivery(kind = "text") {
  return {
    channel: "clickclack",
    messageId: "msg_alpha",
    receipt: { parts: [{ platformMessageId: "msg_alpha", kind }] },
  };
}

const acceptedAlpha = { status: "fulfilled", value: { messageId: "msg_alpha" } };
const retiredSender = {
  status: "rejected",
  error: { message: expect.stringContaining("sender retired") },
};

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing ClickClack sender");
  }
  return value;
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
    hold: () => {
      entered.resolve();
      return release.promise;
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
      requests.push({
        url: url.href,
        init,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const respond = async (stage: RequestStage, response: () => Response) => {
        await options.beforeResponse?.(stage, account);
        return response();
      };
      const created = (body: unknown) => Response.json(body, { status: 201 });
      const request = `${init?.method ?? "GET"} ${url.pathname}`;
      switch (request) {
        case "POST /api/dms":
          return respond("dm", () => created({ conversation: { id: `dcn_${account}` } }));
        case "GET /api/uploads/by-nonce":
          return respond(
            "upload lookup",
            () =>
              new Response("Not found", {
                status: 404,
                headers: { "X-ClickClack-Upload-Nonce": "supported" },
              }),
          );
        case "POST /api/uploads":
          return respond("upload", () =>
            created({ upload: { id: `upl_${account}`, filename: "proof.txt" } }),
          );
        case `POST /api/dms/dcn_${account}/messages`:
        case `POST /api/channels/chn_${account}/messages`:
          return respond("message", () => created({ message: { id: `msg_${account}` } }));
        case `POST /api/messages/msg_${account}/attachments`: {
          const attempt = (attachmentAttempts.get(account) ?? 0) + 1;
          attachmentAttempts.set(account, attempt);
          return respond("attachment", () => {
            if (options.firstAttachmentFails && attempt === 1) {
              throw new Error("First attachment response was lost");
            }
            return Response.json({ ok: true });
          });
        }
        case `GET /api/messages/msg_${account}`:
          return respond("reconciliation", () => {
            if (options.reconciliationFails) {
              throw new Error("Attachment reconciliation was unavailable");
            }
            return Response.json({
              message: {
                id: `msg_${account}`,
                attachments: options.reconciledAttachment ? [{ id: `upl_${account}` }] : [],
              },
            });
          });
        default:
          throw new Error(`Unexpected ClickClack request: ${request}`);
      }
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

function expectAccountConversation(requests: HttpRequest[], account: Account, sent: boolean) {
  const owned = requests.filter(({ url }) => new URL(url).hostname === `${account}.example`);
  expectAccountRequests(owned, account);
  expect(requestPaths(owned)).toEqual([
    "POST /api/dms",
    ...(sent ? [`POST /api/dms/dcn_${account}/messages`] : []),
  ]);
  expect(owned[0]?.body).toEqual({
    workspace_id: `wsp_${account}`,
    member_ids: [`usr_${account}`],
  });
  return owned;
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
      required(clickClackPlugin.outbound?.sendMedia)({ ...mediaContext(), ...context }),
    );
    expect(result).toMatchObject(retiredSender);
    expect(requestPaths(requests)).toEqual([uploadPath]);
  });

  it.each(["active", "revoked"] as const)(
    "preserves %s authority after attachment reconciliation",
    async (state) => {
      const { result, requests } = await withDeferredResponse(
        "reconciliation",
        state,
        (context) =>
          required(clickClackPlugin.message?.send?.media)({ ...mediaContext(), ...context }),
        { firstAttachmentFails: true, reconciliationFails: state === "active" },
      );
      expect(result).toMatchObject(
        state === "active"
          ? acceptedAlpha
          : {
              status: "rejected",
              error: {
                message: expect.stringContaining("sender retired"),
                sentBeforeError: true,
                deliveryResult: {
                  visibleReplySent: true,
                  messageIds: ["msg_alpha"],
                  receipt: expectedDelivery().receipt,
                },
              },
            },
      );
      expect(requestPaths(requests)).toEqual([
        ...mediaPaths,
        reconciliationPath,
        ...(state === "active" ? [attachmentPath] : []),
      ]);
      expect(requests[2]?.body).toEqual({ upload_id: "upl_alpha" });
      if (state === "active") {
        expect(requests[4]?.body).toEqual({ upload_id: "upl_alpha" });
      }
    },
  );

  it.each(["attachment", "reconciliation"] as const)(
    "settles accepted %s success after the sender closes",
    async (stage) => {
      const { result, requests } = await withDeferredResponse(
        stage,
        "revoked",
        (context) =>
          required(clickClackPlugin.outbound?.sendMedia)({ ...mediaContext(), ...context }),
        { firstAttachmentFails: stage === "reconciliation", reconciledAttachment: true },
      );
      expect(result).toMatchObject(acceptedAlpha);
      expect(requestPaths(requests)).toEqual([
        ...mediaPaths,
        ...(stage === "reconciliation" ? [reconciliationPath] : []),
      ]);
    },
  );
});

it("keeps a revoked outbound sender independent from an active message account", async () => {
  const gates = { alpha: createRequestGate(), beta: createRequestGate() };
  const requests = installTransport({
    beforeResponse: (stage, account) => (stage === "dm" ? gates[account].hold() : undefined),
  });
  const alpha = createAuthority();
  const beta = createAuthority();
  const first = observe(
    required(clickClackPlugin.outbound?.sendText)({
      cfg,
      accountId: "alpha",
      to: "dm:usr_alpha",
      text: "Alpha reply",
      ...alpha.context,
    }),
  );
  const second = observe(
    required(clickClackPlugin.message?.send?.text)({
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
    expect(await first).toMatchObject(retiredSender);
    gates.beta.release();
    expect(await second).toMatchObject({ status: "fulfilled", value: { messageId: "msg_beta" } });
    expectAccountConversation(requests, "alpha", false);
    const betaRequests = expectAccountConversation(requests, "beta", true);
    expect(betaRequests[1]?.body).toEqual({
      body: "Beta reply",
      quoted_message_id: "msg_quote",
    });
  } finally {
    gates.alpha.release();
    gates.beta.release();
    await Promise.all([first, second]);
  }
});

it("reports the legacy accepted text identity before a later attachment is revoked", async () => {
  const requests = installTransport();
  const authority = createAuthority();
  const progress: unknown[] = [];
  const result = await observe(
    required(clickClackPlugin.outbound?.sendMedia)({
      ...mediaContext(),
      ...authority.context,
      onDeliveryResult: (delivery) => {
        progress.push(delivery);
        authority.revoke();
      },
    }),
  );
  expect(progress).toMatchObject([expectedDelivery()]);
  expect(result).toMatchObject({
    status: "rejected",
    error: { sentBeforeError: true, deliveryResult: { messageIds: ["msg_alpha"] } },
  });
  expect(requestPaths(requests)).toEqual([uploadPath, messagePath]);
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
        results: [expectedDelivery(state === "active" ? "media" : "text")],
        receipt: { platformMessageIds: ["msg_alpha"] },
      });
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
      } else {
        expect(queued).toEqual([]);
      }
      expect(requestPaths(requests)).toEqual([
        "GET /api/uploads/by-nonce",
        uploadPath,
        messagePath,
        ...(state === "active" ? [attachmentPath] : []),
      ]);
      expect(requests[2]?.body).toMatchObject({
        body: "A file reply",
        quoted_message_id: "msg_quote",
      });
    });
  },
);
