import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createChannelIngressMonitor } from "openclaw/plugin-sdk/channel-outbound";
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

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return { ...actual, createChannelIngressMonitor: vi.fn(actual.createChannelIngressMonitor) };
});

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

function createRawEvent(params?: { messageId?: string; roomToken?: string; text?: string }) {
  const { body } = createSignedCreateMessageRequest();
  const payload = JSON.parse(body) as {
    object: { id: string; content: string; name: string };
    target: { id: string };
  };
  payload.object.id = params?.messageId ?? "msg-1";
  payload.target.id = params?.roomToken ?? "test-room-token";
  payload.object.content = params?.text ?? "hello";
  payload.object.name = params?.text ?? "hello";
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

async function expectClaim(id: string, laneKey: string, rawEvent?: string) {
  expect(await queue.listClaims()).toEqual([
    expect.objectContaining({
      id,
      laneKey,
      ...(rawEvent === undefined ? {} : { payload: expect.objectContaining({ rawEvent }) }),
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
  vi.mocked(createChannelIngressMonitor).mockClear();
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
      body: createRawEvent({ messageId: "msg-restart", text: "ordinary text" }),
      lane: "room:test-room-token",
      message: {
        messageId: "msg-restart",
        roomToken: "test-room-token",
        text: "ordinary text",
        mediaType: "text/plain",
      },
    },
    {
      kind: "file_shared",
      body: createFileSharedActivityBody(),
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
          declaredSizeBytes: 24_576,
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
      // Scheduling and capacity races belong to the shared ingress monitor suite.
      expect(createChannelIngressMonitor).toHaveBeenCalledWith(
        expect.objectContaining({
          drain: expect.objectContaining({ startLimit: 32, adoptionStallTimeoutMs: 5_000 }),
        }),
      );
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

  it("admits a Talk file share with a numeric byte size", async () => {
    const deliver = vi.fn<NextcloudTalkIngressDeliver>(async () => {});
    const spool = startSpool(queue, deliver);
    await receive(spool, createFileSharedActivityBody({ fileSize: 1_234_567 }));
    expectDelivered(deliver, {
      attachment: expect.objectContaining({ declaredSizeBytes: 1_234_567 }),
    });
  });

  it("bounds malformed file metadata as an unavailable attachment", async () => {
    const body = activityBody({
      id: "4245",
      content: JSON.stringify({ message: "{file}", parameters: { file: { type: "file" } } }),
    });
    const deliver = vi.fn<NextcloudTalkIngressDeliver>(async () => {});
    const spool = startSpool(queue, deliver);
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
    {
      name: "malformed normal-message",
      body: activityBody({ id: "4246", content: "{not-json" }),
      event: undefined,
    },
    ...[
      { name: "participant_joined", message: "Alice joined the conversation", parameters: {} },
      {
        name: "object_shared",
        message: "{object}",
        parameters: { object: { type: "deck-card", id: "redacted" } },
      },
    ].map(({ name, message, parameters }) => ({
      name,
      body: activityBody({ id: "4243", name, content: JSON.stringify({ message, parameters }) }),
      event: "type=Activity objectType=Note",
    })),
    {
      name: "non-message document",
      body: JSON.stringify({ type: "Create", object: { type: "Document", id: "file-1" } }),
      event: "type=Create objectType=Document",
    },
  ])("ignores $name without consuming its message id", async ({ body, event }) => {
    const deliver = vi.fn();
    const log = vi.fn();
    await expectIgnored(startSpool(queue, deliver, log), body, deliver);
    if (event) {
      expect(log).toHaveBeenCalledWith(
        `nextcloud-talk: ignored non-message webhook event (${event})`,
      );
    }
  });
});
