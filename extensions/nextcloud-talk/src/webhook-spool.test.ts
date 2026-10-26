import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileSharedActivityBody,
  createSignedCreateMessageRequest,
  createVoiceMessageActivityBody,
} from "./monitor.test-fixtures.js";
import {
  migrateNextcloudTalkLegacyReplayState,
  parseNextcloudTalkFileSharedActivity,
} from "./webhook-spool-state.js";
import { createNextcloudTalkWebhookSpool } from "./webhook-spool.js";

type NextcloudTalkIngressQueue = NonNullable<
  Parameters<typeof createNextcloudTalkWebhookSpool>[0]["queue"]
>;
type NextcloudTalkIngressPayload = Parameters<NextcloudTalkIngressQueue["enqueue"]>[1];
type NextcloudTalkIngressDeliver = Parameters<typeof createNextcloudTalkWebhookSpool>[0]["deliver"];
const deferredDelivery = () =>
  vi.fn<NextcloudTalkIngressDeliver>(async (_message, lifecycle) => {
    lifecycle.onDeferred();
  });
const adoptedDelivery = () =>
  vi.fn<NextcloudTalkIngressDeliver>(async (_message, lifecycle) => {
    await lifecycle.onAdopted();
  });

function expectDelivered(deliver: NextcloudTalkIngressDeliver, message: object) {
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining(message), expect.any(Object));
}

function activityBody(object: { id: string; name?: string; content: string }) {
  const payload = JSON.parse(createFileSharedActivityBody()) as {
    object: { id: string; name: string; content: string };
  };
  return JSON.stringify({ ...payload, object: { ...payload.object, ...object } });
}

function quoted(content: unknown, object: Record<string, unknown> = {}) {
  return {
    type: "Note",
    actor: { type: "Person", id: "users/ada", name: "Ada" },
    object: { type: "Note", id: "parent-1", content, ...object },
  };
}

function startDelivery(deliver = adoptedDelivery()) {
  return { deliver, spool: startSpool(queue, deliver) };
}

function createRawEvent(params?: {
  messageId?: string;
  roomToken?: string;
  text?: string;
  quote?: unknown;
}) {
  const { body } = createSignedCreateMessageRequest();
  const payload = JSON.parse(body) as {
    object: { id: string; content: string; name: string; inReplyTo?: unknown };
    target: { id: string };
  };
  payload.object.id = params?.messageId ?? "msg-1";
  payload.target.id = params?.roomToken ?? "test-room-token";
  payload.object.content = params?.text ?? "hello";
  payload.object.name = params?.text ?? "hello";
  if (params && Object.hasOwn(params, "quote")) {
    payload.object.inReplyTo = params.quote;
  }
  return JSON.stringify(payload);
}

function startSpool(
  queue: NextcloudTalkIngressQueue,
  deliver: NextcloudTalkIngressDeliver,
  log = vi.fn(),
) {
  const spool = createNextcloudTalkWebhookSpool({
    accountId: "default",
    queue,
    deliver,
    runtime: { error: vi.fn(), log },
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
    legacyReplayStore: null,
  });
  spools.push(spool);
  return spool;
}

async function receive(spool: ReturnType<typeof startSpool>, body: string) {
  await expect(spool.receive(body)).resolves.toBe("accepted");
  await spool.waitForIdle();
}

async function expectClaim(id: string, laneKey: string, rawEvent: string) {
  expect(await queue.listClaims()).toEqual([
    expect.objectContaining({
      id,
      laneKey,
      payload: expect.objectContaining({ rawEvent }),
    }),
  ]);
}

async function expectIgnored(
  spool: ReturnType<typeof startSpool>,
  body: string,
  deliver: ReturnType<typeof vi.fn>,
) {
  await expect(spool.receive(body)).resolves.toBe("ignored");
  expect(await queue.listPending({ limit: "all" })).toEqual([]);
  expect(deliver).not.toHaveBeenCalled();
}

let queue: NextcloudTalkIngressQueue;
let stateDir: string;
const spools: ReturnType<typeof createNextcloudTalkWebhookSpool>[] = [];
beforeEach(async () => {
  stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nextcloud-ingress-")),
  );
  queue = createChannelIngressQueueForTests<NextcloudTalkIngressPayload>({
    channelId: "nextcloud-talk",
    accountId: "default",
    stateDir,
  });
});
afterEach(async () => {
  await Promise.all(spools.splice(0).map((spool) => spool.stop()));
  closeOpenClawStateDatabaseForTest();
  await fs.rm(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Nextcloud Talk durable ingress", () => {
  it.each([
    ["plain text", "Plain quoted text", "Plain quoted text"],
    [
      "referenced rich labels without unreferenced metadata",
      JSON.stringify({
        message: "Ask {mention-user1} about {file}",
        parameters: {
          "mention-user1": { type: "user", name: "Ada", id: "ada" },
          file: { type: "file", name: "plan.pdf", link: "https://unused.invalid/secret" },
          unused: { name: "Do not include me", link: "https://unused.invalid/other" },
        },
      }),
      "Ask Ada about plan.pdf",
    ],
  ])("delivers %s as quoted context", async (_kind, content, body) => {
    const { deliver, spool } = startDelivery();
    await receive(spool, createRawEvent({ quote: quoted(content) }));
    expectDelivered(deliver, {
      quote: { id: "parent-1", senderId: "users/ada", senderName: "Ada", body },
    });
  });

  it.each([
    ["non-object", "parent-1"],
    ["missing parent", { type: "Note", actor: { id: "users/ada" } }],
    ["malformed structured body", quoted(JSON.stringify({ message: 7, parameters: [] }))],
    ["invalid parent body", quoted({ message: "Wrong shape" })],
  ])("keeps the current message when optional quote is %s", async (_kind, quote) => {
    const { deliver, spool } = startDelivery();
    await receive(spool, createRawEvent({ text: "Current text", quote }));
    expect(deliver).toHaveBeenCalledTimes(1);
    expectDelivered(deliver, { messageId: "msg-1", text: "Current text" });
    expect(deliver.mock.calls[0]?.[0]).not.toHaveProperty("quote");
  });

  it("accepts file metadata without the optional hide-download flag", () => {
    const envelope = JSON.parse(createFileSharedActivityBody()) as { object: { content: string } };
    const content = JSON.parse(envelope.object.content) as {
      parameters: { file: Record<string, unknown> };
    };
    delete content.parameters.file["hide-download"];
    envelope.object.content = JSON.stringify(content);
    expect(parseNextcloudTalkFileSharedActivity(envelope as Record<string, unknown>)).toEqual(
      expect.objectContaining({ attachment: expect.objectContaining({ hideDownload: false }) }),
    );
  });

  it("finishes durable admission for a receive that began before migration-time stop", async () => {
    const migration = Promise.withResolvers<[]>();
    const entries = vi.fn(() => migration.promise);
    const deliver = vi.fn();
    const prune = vi.spyOn(queue, "prune");
    const spool = createNextcloudTalkWebhookSpool({
      accountId: "default",
      queue,
      deliver,
      runtime: { error: vi.fn(), log: vi.fn() },
      pollIntervalMs: 60_000,
      legacyReplayStore: { entries, clear: vi.fn(async () => {}) },
    });

    const receiving = spool.receive(createRawEvent({ messageId: "msg-before-stop" }));
    const stopping = spool.stop();
    await vi.waitFor(() => expect(entries).toHaveBeenCalledTimes(1));
    migration.resolve([]);

    await expect(receiving).resolves.toBe("accepted");
    await stopping;
    expect(prune).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(await queue.listPending({ limit: "all" })).toHaveLength(1);
  });

  it("migrates the shipped replay guard window into completion tombstones", async () => {
    const store = {
      entries: vi.fn(async () => [{ value: { key: "test-room:msg-legacy", seenAt: Date.now() } }]),
      clear: vi.fn(async () => {}),
    };

    await migrateNextcloudTalkLegacyReplayState({ queue, store });
    expect((await queue.enqueue("msg-legacy", {} as NextcloudTalkIngressPayload)).kind).toBe(
      "completed",
    );
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it("propagates append failure without live-dispatch fallback", async () => {
    const appendError = new Error("sqlite unavailable");
    const failingQueue = {
      ...queue,
      enqueue: vi.fn().mockRejectedValue(appendError),
    } satisfies NextcloudTalkIngressQueue;
    const deliver = vi.fn();
    const spool = startSpool(failingQueue, deliver);
    await expect(spool.receive(createRawEvent())).rejects.toBe(appendError);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("keeps the claim until adoption finalization reaches its terminal callback", async () => {
    let adopt: (() => void | Promise<void>) | undefined;
    const deliver = vi.fn(async (_message, lifecycle) => {
      lifecycle.onAdoptionFinalizing();
      adopt = lifecycle.onAdopted;
    });
    const spool = startSpool(queue, deliver);
    const rawEvent = createRawEvent({ messageId: "msg-finalizing" });
    await spool.receive(rawEvent);
    await spool.waitForIdle();
    expect(await queue.listClaims()).toHaveLength(1);
    if (!adopt) {
      throw new Error("Expected adoption callback after finalization");
    }

    await adopt();
    await spool.receive(rawEvent);
    await spool.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      kind: "text",
      body: createRawEvent({
        messageId: "msg-restart",
        text: "What about this?",
        quote: {
          ...quoted(JSON.stringify({ message: "Look north.", parameters: [] }), {
            inReplyTo: { object: { id: "ancestor", content: "Do not include this ancestor" } },
          }),
          actor: { type: "Person", id: "bots/quoted-bot", name: "Quoted bot" },
        },
      }),
      lane: "room:test-room-token",
      message: {
        messageId: "msg-restart",
        roomToken: "test-room-token",
        text: "What about this?",
        senderId: "alice",
        mediaType: "text/plain",
        quote: {
          id: "parent-1",
          senderId: "bots/quoted-bot",
          senderName: "Quoted bot",
          body: "Look north.",
        },
      },
    },
    {
      kind: "file_shared",
      body: createFileSharedActivityBody({ fileSize: 1_234_567 }),
      lane: "room:redacted-room-token",
      message: {
        messageId: "4242",
        roomToken: "redacted-room-token",
        senderId: "users/alice",
        senderName: "Alice",
        roomName: "Receipts",
        text: "@openclaw please inspect this receipt",
        timestamp: expect.any(Number),
        attachment: {
          fileId: "9001",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: 1_234_567,
          shareUrl: "https://nextcloud.example/s/redacted-share-token",
          hideDownload: false,
        },
      },
    },
    {
      kind: "voice",
      body: createVoiceMessageActivityBody(),
      lane: "room:redacted-room-token",
      message: {
        messageId: "4250",
        roomToken: "redacted-room-token",
        senderId: "users/alice",
        senderName: "Alice",
        roomName: "Voice notes",
        text: "",
        attachment: {
          fileId: "9010",
          name: "voice-note.wav",
          mimeType: "audio/wav",
          declaredSizeBytes: 557_804,
          shareUrl: "https://nextcloud.example/s/redacted-voice-share-token",
          hideDownload: false,
        },
      },
    },
  ])(
    "durably admits and recovers $kind in its original lane exactly once",
    async ({ body, lane, message }) => {
      const deferred = deferredDelivery();
      const interrupted = startSpool(queue, deferred);
      await receive(interrupted, body);
      await expectClaim(message.messageId, lane, body);
      expectDelivered(deferred, message);
      await interrupted.stop();
      const deliver = adoptedDelivery();
      const recovered = startSpool(queue, deliver);
      await recovered.waitForIdle();
      await receive(recovered, body);
      expect(deliver).toHaveBeenCalledTimes(1);
      expectDelivered(deliver, message);
    },
  );

  it("bounds malformed file metadata as an unavailable attachment", async () => {
    const body = activityBody({
      id: "4245",
      content: JSON.stringify({ message: "{file}", parameters: { file: { type: "file" } } }),
    });
    const { deliver, spool } = startDelivery(vi.fn<NextcloudTalkIngressDeliver>(async () => {}));
    await receive(spool, body);
    await receive(spool, body);
    expect(deliver).toHaveBeenCalledTimes(1);
    expectDelivered(deliver, {
      messageId: "4245",
      text: "",
      attachmentIssue: "media_missing_metadata",
    });
    expect(deliver.mock.calls[0]?.[0]).not.toHaveProperty("attachment");
  });

  it.each([
    ["malformed normal-message", activityBody({ id: "4246", content: "{not-json" })],
    ["participant_joined", activityBody({ id: "4243", name: "participant_joined", content: "{}" })],
    [
      "non-message document",
      JSON.stringify({ type: "Create", object: { type: "Document", id: "file-1" } }),
    ],
  ])("ignores %s without consuming its message id", async (_name, body) => {
    const deliver = vi.fn();
    const log = vi.fn();
    await expectIgnored(startSpool(queue, deliver, log), body, deliver);
    expect(log).toHaveBeenCalledOnce();
  });
});
