// Feishu tests cover send authority across every physical message one delivery fans out.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createPluginRuntimeMock,
  createTestRegistry,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuPlugin } from "./channel.js";
import { resetFeishuProxyAgentForTest } from "./client.js";
import {
  AUTH_PATH,
  COMMENT_PATH,
  FILE_PATH,
  MESSAGE_PATH,
  TARGET,
  withFeishuTransport,
} from "./outbound.send-authority.test-fixtures.js";
import { setFeishuRuntime } from "./runtime.js";

const { resolveProxy } = vi.hoisted(() => ({
  resolveProxy: vi.fn<() => Promise<undefined>>(),
}));

vi.mock("openclaw/plugin-sdk/extension-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/extension-shared")>()),
  resolveAmbientNodeProxyAgent: resolveProxy,
}));

const COMMENT_TARGET = "comment:docx:doc_fixture:comment_fixture";
const COMMENT_QUERY_PATH = `${COMMENT_PATH}/batch_query`;
const COMMENT_REPLY_PATH = `${COMMENT_PATH}/comment_fixture/replies`;
const MEDIA_URL = "https://media.example/note.txt";

const completionRetention = {
  idPrefix: "feishu-handoff-",
  maxAgeMs: 60_000,
  maxEntries: 10,
} as const;

// Three messages at the 4000-character cut, so the fanout has to survive the authority
// question twice more after the one core asked around the whole adapter call.
const LONG_REPLY = Array.from(
  { length: 300 },
  (_entry, index) => `Line ${index} of a long outbound reply.`,
).join("\n");
const LONG_REPLY_MESSAGES = 3;

/** The registered formatted entry: what core routes an uncut reply through. */
function registeredFormattedSend() {
  const send = feishuPlugin.outbound?.sendFormattedText;
  if (!send) {
    throw new Error("Expected the registered Feishu formatted text sender");
  }
  return send;
}

function registeredPayloadSend() {
  const send = feishuPlugin.outbound?.sendPayload;
  if (!send) {
    throw new Error("Expected the registered Feishu payload sender");
  }
  return send;
}

function registeredMediaSend() {
  const send = feishuPlugin.message?.send?.media;
  if (!send) {
    throw new Error("Expected the registered Feishu media sender");
  }
  return send;
}

/** A writer whose authority is revoked in place, the way a replaced turn revokes one. */
function createSender() {
  let current = true;
  return {
    assertDirectAdapterHandoff: () => {
      if (!current) {
        throw new Error("Sender retired");
      }
    },
    onPlatformSendDispatch: vi.fn(async () => {}),
    retire: () => {
      current = false;
    },
  };
}

/**
 * Retirement keyed on the first message the reader actually received, not on a count of
 * authority checks: a check core adds or drops elsewhere cannot then move where this
 * revocation lands.
 */
function retireAfterFirstDelivery(sender: { retire: () => void }) {
  const delivered: string[] = [];
  return {
    delivered,
    onDeliveryResult: (result: { messageId?: string }) => {
      delivered.push(result.messageId ?? "");
      if (delivered.length === 1) {
        sender.retire();
      }
    },
  };
}

function errorCauses(error: unknown) {
  return collectErrorGraphCandidates(error, (current) => [current.cause]);
}

/** A refused message is permanently not dispatched, never a retryable send failure. */
function expectNotDispatched(error: unknown) {
  expect(errorCauses(error)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
        retryable: false,
      }),
    ]),
  );
}

/** The rich-post text of one recorded message request, as the reader received it. */
function postText(request: { body: string }): string {
  const envelope = JSON.parse(request.body) as { content?: string };
  const post = JSON.parse(envelope.content ?? "{}") as {
    zh_cn?: { content?: { tag?: string; text?: string }[][] };
  };
  return (post.zh_cn?.content ?? [])
    .flat()
    .map((element) => element.text ?? "")
    .join("");
}

function messageTexts(requests: readonly { path: string; body: string }[]): string[] {
  return requests.filter((request) => request.path === MESSAGE_PATH).map(postText);
}

/**
 * Every transmitted message split back into authored lines, in send order. The rich-post
 * envelope carries a whole chunk in one element run, so the line breaks live inside the
 * text rather than in the element structure.
 */
function messageLines(requests: readonly { path: string; body: string }[]): string[] {
  return messageTexts(requests).flatMap((text) => text.split("\n"));
}

/** The text of one recorded document-comment reply, as the thread received it. */
function commentReplyText(request: { body: string }): string {
  const envelope = JSON.parse(request.body) as {
    content?: { elements?: { text_run?: { text?: string } }[] };
  };
  return (envelope.content?.elements ?? []).map((element) => element.text_run?.text ?? "").join("");
}

function partialDelivery(outcome: unknown) {
  return isChannelPartialDeliveryError(outcome) ? outcome.deliveryResult : undefined;
}

function readDeliveryQueueRow(stateDir: string, id: string) {
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        `SELECT status, recovery_state, platform_send_started_at
           FROM delivery_queue_entries
          WHERE queue_name = 'outbound-prepared-v1' AND id = ?`,
      )
      .get(id) as
      | { status: string; recovery_state: string | null; platform_send_started_at: number | null }
      | undefined;
  } finally {
    database.close();
  }
}

function registerFeishuPlugin() {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "feishu", plugin: feishuPlugin, source: "test" }]),
  );
  resetGlobalHookRunner();
}

function stubLoadedMedia() {
  setFeishuRuntime(
    createPluginRuntimeMock({
      media: {
        loadWebMedia: async () => ({
          buffer: Buffer.from("attachment"),
          fileName: "note.txt",
          contentType: "text/plain",
          kind: undefined,
        }),
      },
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  resolveProxy.mockResolvedValue(undefined);
  resetFeishuProxyAgentForTest();
  registerFeishuPlugin();
});

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resetFeishuProxyAgentForTest();
  resolveProxy.mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/extension-shared");
  vi.resetModules();
});

describe("Feishu outbound fanout authority over the Lark transport", () => {
  it("delivers every message of a formatted reply while its sender stays current", async () => {
    await withFeishuTransport(async (fixture) => {
      const sender = createSender();
      const delivered: string[] = [];
      // Distinct ids per message, so a receipt that kept only one of them is visible.
      let accepted = 0;
      fixture.respond(async (request, response) => {
        if (request.path !== MESSAGE_PATH) {
          return false;
        }
        accepted += 1;
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            code: 0,
            data: { message_id: `om_accepted_${String(accepted)}`, chat_id: TARGET },
          }),
        );
        return true;
      });
      const [result] = await registeredFormattedSend()({
        ...sender,
        cfg: fixture.cfg,
        to: TARGET,
        text: LONG_REPLY,
        onDeliveryResult: (progress: { messageId?: string }) => {
          delivered.push(progress.messageId ?? "");
        },
      } as never);

      const expectedIds = Array.from(
        { length: LONG_REPLY_MESSAGES },
        (_entry, index) => `om_accepted_${String(index + 1)}`,
      );
      expect(fixture.requests.map((request) => request.path)).toEqual([
        AUTH_PATH,
        ...Array.from({ length: LONG_REPLY_MESSAGES }, () => MESSAGE_PATH),
      ]);
      const texts = messageTexts(fixture.requests);
      // Every authored line, once each and in order. Containment alone would pass a fanout
      // that duplicated or reordered a chunk. Trailing hard-break markers belong to the
      // formatter and are asserted elsewhere, so they are trimmed off here.
      expect(messageLines(fixture.requests).map((line) => line.trimEnd())).toEqual(
        LONG_REPLY.split("\n"),
      );
      expect(texts.every((text) => text.length <= 4000)).toBe(true);
      expect(delivered).toEqual(expectedIds);
      expect(result?.receipt?.platformMessageIds).toEqual(expectedIds);
      expect(sender.onPlatformSendDispatch).toHaveBeenCalledTimes(LONG_REPLY_MESSAGES);
    });
  });

  it("stops the formatted fanout once its sender retires after the first message", async () => {
    await withFeishuTransport(async ({ cfg, requests }) => {
      const sender = createSender();
      const { onDeliveryResult, delivered } = retireAfterFirstDelivery(sender);
      const outcome = await registeredFormattedSend()({
        ...sender,
        cfg,
        to: TARGET,
        text: LONG_REPLY,
        onDeliveryResult,
      } as never).catch((cause: unknown) => cause);

      expectNotDispatched(outcome);
      // One message, and nothing after it: no later chunk, upload, card or comment.
      expect(requests.map((request) => request.path)).toEqual([AUTH_PATH, MESSAGE_PATH]);
      expect(delivered).toEqual(["om_accepted"]);
      // The refused message never reached the refresh, so it never claimed dispatch timing.
      expect(sender.onPlatformSendDispatch).toHaveBeenCalledOnce();
    });
  });

  // Losing authority mid-fanout must not lose the receipts of the messages that already
  // reached the reader: the turn would then record the whole answer as undelivered and a
  // retry would repeat the text the reader is looking at.
  it("reports the message the reader received when its sender retires mid-fanout", async () => {
    await withFeishuTransport(async ({ cfg, requests }) => {
      const sender = createSender();
      const { onDeliveryResult } = retireAfterFirstDelivery(sender);
      const outcome = await registeredFormattedSend()({
        ...sender,
        cfg,
        to: TARGET,
        text: LONG_REPLY,
        onDeliveryResult,
      } as never).catch((cause: unknown) => cause);

      const accepted = messageTexts(requests);
      expect(accepted).toHaveLength(1);
      const delivery = partialDelivery(outcome);
      // A rejection that threw the accepted receipts away reports none of them.
      expect(delivery?.messageIds).toEqual(["om_accepted"]);
      expect(delivery?.receipt?.platformMessageIds).toEqual(["om_accepted"]);
      // The evidence the delivery layer reads to tell a refused message apart from an
      // answer that partly reached the reader. A raw no-dispatch rejection carries none.
      expect(delivery?.visibleReplySent).toBe(true);
      // The accepted prefix is exactly the text of the one message that went out, not the
      // authored answer and not the suffix the reader never saw.
      expect(delivery?.content).toBe(accepted[0]);
      expect(LONG_REPLY.length).toBeGreaterThan(delivery?.content?.length ?? 0);
    });
  });

  it("stops a document-comment fanout once its sender retires after the first reply", async () => {
    await withFeishuTransport(async ({ cfg, requests }) => {
      const sender = createSender();
      const { onDeliveryResult, delivered } = retireAfterFirstDelivery(sender);
      const outcome = await registeredFormattedSend()({
        ...sender,
        cfg,
        to: COMMENT_TARGET,
        text: LONG_REPLY,
        onDeliveryResult,
      } as never).catch((cause: unknown) => cause);

      expectNotDispatched(outcome);
      expect(requests.map((request) => request.path)).toEqual([
        AUTH_PATH,
        COMMENT_QUERY_PATH,
        COMMENT_REPLY_PATH,
      ]);
      expect(delivered).toEqual(["reply_accepted"]);
      const delivery = partialDelivery(outcome);
      expect(delivery?.messageIds).toEqual(["reply_accepted"]);
      expect(delivery?.visibleReplySent).toBe(true);
      expect(delivery?.receipt?.platformMessageIds).toEqual(["reply_accepted"]);
      // Exactly the reply the thread received. Asserting only that it is shorter than the
      // authored answer would also accept an arbitrary wrong string.
      const acceptedReply = requests.find((request) => request.path === COMMENT_REPLY_PATH);
      expect(acceptedReply).toBeDefined();
      expect(delivery?.content).toEqual(
        acceptedReply ? commentReplyText(acceptedReply) : undefined,
      );
      expect(LONG_REPLY.length).toBeGreaterThan(delivery?.content?.length ?? 0);
    });
  });

  // A presentation payload with an attachment is several platform messages behind the one
  // authority check core made around this call: the upload and its message, then the card.
  it("stops a payload card once its sender retires after the media message", async () => {
    await withFeishuTransport(async ({ cfg, requests }) => {
      stubLoadedMedia();
      const sender = createSender();
      const { onDeliveryResult, delivered } = retireAfterFirstDelivery(sender);
      const outcome = await registeredPayloadSend()({
        ...sender,
        cfg,
        to: TARGET,
        text: "One chart.",
        onDeliveryResult,
        payload: {
          text: "One chart.",
          mediaUrls: [MEDIA_URL],
          presentation: { blocks: [{ type: "text", text: "One chart." }] },
        },
      } as never).catch((cause: unknown) => cause);

      expectNotDispatched(outcome);
      // The upload and its message went out; the finalizing card never did.
      expect(requests.map((request) => request.path)).toEqual([AUTH_PATH, FILE_PATH, MESSAGE_PATH]);
      expect(delivered).toEqual(["om_accepted"]);
    });
  });

  it("stops the attachment once its sender retires on the caption, keeping the receipt", async () => {
    await withFeishuTransport(async ({ cfg, requests }) => {
      stubLoadedMedia();
      const sender = createSender();
      const { onDeliveryResult, delivered } = retireAfterFirstDelivery(sender);
      const outcome = await registeredMediaSend()({
        ...sender,
        cfg,
        to: TARGET,
        text: "Here is the chart.",
        mediaUrl: MEDIA_URL,
        onDeliveryResult,
      } as never).catch((cause: unknown) => cause);

      expectNotDispatched(outcome);
      // The caption reached the reader; the attachment never started its upload, and the
      // refusal never degraded into one more fallback message the turn no longer owns.
      expect(requests.map((request) => request.path)).toEqual([AUTH_PATH, MESSAGE_PATH]);
      expect(delivered).toEqual(["om_accepted"]);
      const delivery = partialDelivery(outcome);
      expect(delivery?.messageIds).toEqual(["om_accepted"]);
      expect(delivery?.visibleReplySent).toBe(true);
      expect(messageTexts(requests)).toEqual([expect.stringContaining("Here is the chart.")]);
    });
  });

  // A formatted reply this channel cuts itself is several platform messages behind one
  // durable attempt, so an accepted prefix has to land on the queue as a send that partly
  // happened: the remaining messages are not sent, and what the reader already has is not
  // replayable.
  it("records an accepted prefix as a partial durable send that never replays", async () => {
    const deliveryIntentId = "feishu-handoff-durable-partial";
    await withStateDirEnv("openclaw-feishu-handoff-partial-", async ({ stateDir }) => {
      await withFeishuTransport(async ({ cfg, requests }) => {
        registerFeishuPlugin();
        const sender = createSender();
        const { onDeliveryResult, delivered } = retireAfterFirstDelivery(sender);
        const outcome = await sendDurableMessageBatch({
          cfg,
          channel: "feishu",
          to: TARGET,
          accountId: "default",
          durability: "required",
          deliveryIntentId,
          completionRetention,
          maxRetries: 2,
          assertDirectAdapterHandoff: sender.assertDirectAdapterHandoff,
          onDeliveryResult,
          payloads: [{ text: LONG_REPLY }],
        });

        const visibleRequests = () =>
          requests.filter((request) => request.path.startsWith(MESSAGE_PATH));
        expect(visibleRequests()).toHaveLength(1);
        expect(delivered).toEqual(["om_accepted"]);
        expect(outcome.status).toBe("partial_failed");
        if (outcome.status === "partial_failed") {
          expect(outcome.receipt.platformMessageIds).toEqual(["om_accepted"]);
        }
        // An accepted prefix is not a wholly unsent send: it stays pending and ambiguous
        // rather than being flattened to failed while the recovery decision is open.
        expect(readDeliveryQueueRow(stateDir, deliveryIntentId)).toMatchObject({
          status: "pending",
          recovery_state: "unknown_after_send",
        });

        await drainPendingDeliveries({
          drainKey: "feishu:default",
          logLabel: "Feishu fanout authority recovery",
          cfg,
          stateDir,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          selectEntry: (entry) => ({ match: entry.channel === "feishu", bypassBackoff: true }),
        });

        // Nothing replays what the reader already has, and the drain settles the entry.
        expect(visibleRequests()).toHaveLength(1);
        expect(readDeliveryQueueRow(stateDir, deliveryIntentId)?.status).toBe("failed");
      });
    });
  });

  // Dispatch has begun once the request is on the wire. A response lost after that point
  // cannot prove the message was never delivered, so the entry records the ambiguity and
  // nothing replays it.
  it("does not replay a Feishu message whose response is lost after dispatch", async () => {
    const deliveryIntentId = "feishu-handoff-lost-response";
    await withStateDirEnv("openclaw-feishu-handoff-ambiguous-", async ({ stateDir }) => {
      await withFeishuTransport(async (fixture) => {
        registerFeishuPlugin();
        fixture.respond(async (request, response) => {
          if (request.path === MESSAGE_PATH) {
            // A real request that started and then lost its response.
            response.destroy();
            return true;
          }
          return false;
        });
        const outcome = await sendDurableMessageBatch({
          cfg: fixture.cfg,
          channel: "feishu",
          to: TARGET,
          accountId: "default",
          durability: "required",
          deliveryIntentId,
          completionRetention,
          maxRetries: 2,
          payloads: [{ text: "Do not replay an ambiguous provider call." }],
        });

        const visibleRequests = () =>
          fixture.requests.filter((request) => request.path.startsWith(MESSAGE_PATH));
        expect(outcome.status).toBe("failed");
        expect(visibleRequests()).toHaveLength(1);
        // The client refreshes the durable timing immediately before the request reaches
        // the HTTP adapter, so a lost response is recorded as the ambiguous outcome it is.
        const row = readDeliveryQueueRow(stateDir, deliveryIntentId);
        expect(row).toMatchObject({ status: "pending", recovery_state: "unknown_after_send" });
        expect(row?.platform_send_started_at).toEqual(expect.any(Number));

        await drainPendingDeliveries({
          drainKey: "feishu:default",
          logLabel: "Feishu ambiguous provider recovery",
          cfg: fixture.cfg,
          stateDir,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          selectEntry: (entry) => ({ match: entry.channel === "feishu", bypassBackoff: true }),
        });

        // A request count alone would also pass if the drain skipped the entry, so assert
        // the entry itself reached a terminal state that refuses to replay.
        expect(visibleRequests()).toHaveLength(1);
        expect(readDeliveryQueueRow(stateDir, deliveryIntentId)?.status).toBe("failed");
      });
    });
  });

  // The ambient send scope this adapter establishes around every text sender it advertises
  // is what covers the window between core's own check and the request reaching the wire.
  // Removing the `sendFormattedText` wrapper leaves this entry with no scope for the
  // client's authority checks to find, and each case below then delivers the message.
  it.each([
    { stage: "token preparation", waitPath: AUTH_PATH },
    { stage: "the request interceptor", waitPath: MESSAGE_PATH },
  ])("stops a formatted entry retired during $stage", async ({ waitPath }) => {
    await withFeishuTransport(async (fixture) => {
      const sender = createSender();
      const started = fixture.gate();
      const release = fixture.gate();
      const wait = async () => {
        started.resolve();
        await release.promise;
      };
      if (waitPath === MESSAGE_PATH) {
        fixture.intercept(MESSAGE_PATH, wait);
      } else {
        fixture.respond(async (request) => {
          if (request.path === AUTH_PATH) {
            await wait();
          }
          return false;
        });
      }
      const outcome = fixture.track(
        registeredFormattedSend()({
          ...sender,
          cfg: fixture.cfg,
          to: TARGET,
          text: "A formatted entry must not outlive its sender.",
        } as never).catch((cause: unknown) => cause),
      );
      await started.promise;
      sender.retire();
      release.resolve();

      expectNotDispatched(await outcome);
      expect(fixture.requests.map((request) => request.path)).toEqual([AUTH_PATH]);
    });
  });
});
