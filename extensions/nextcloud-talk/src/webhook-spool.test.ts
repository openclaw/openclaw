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
  return createNextcloudTalkWebhookSpool({
    accountId: "default",
    queue,
    deliver,
    runtime: { error: vi.fn(), log },
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
    legacyReplayStore: null,
  });
}

async function withSpool(
  spool: ReturnType<typeof startSpool>,
  run: (spool: ReturnType<typeof startSpool>) => Promise<void>,
): Promise<void> {
  try {
    await run(spool);
  } finally {
    await spool.stop();
  }
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
    await withSpool(startSpool(failingQueue, deliver), async (spool) => {
      await expect(spool.receive(createRawEvent())).rejects.toBe(appendError);
      expect(deliver).not.toHaveBeenCalled();
    });
  });

  it("drains other rooms while keeping unadopted same-room deliveries ordered", async () => {
    const roomADelivery = Promise.withResolvers<void>();
    const roomAStarted = Promise.withResolvers<void>();
    const roomBAdopted = Promise.withResolvers<void>();
    const secondRoomAAdopted = Promise.withResolvers<void>();
    const delivered: string[] = [];
    const spool = startSpool(queue, async (message, lifecycle) => {
      delivered.push(message.messageId);
      if (message.messageId === "room-a-1") {
        roomAStarted.resolve();
        await roomADelivery.promise;
      }
      await lifecycle.onAdopted();
      if (message.messageId === "room-b-1") {
        roomBAdopted.resolve();
      } else if (message.messageId === "room-a-2") {
        secondRoomAAdopted.resolve();
      }
    });

    try {
      await spool.receive(createRawEvent({ messageId: "room-a-1", roomToken: "room-a" }));
      await roomAStarted.promise;
      expect(delivered).toEqual(["room-a-1"]);

      await spool.receive(createRawEvent({ messageId: "room-a-2", roomToken: "room-a" }));
      await spool.receive(createRawEvent({ messageId: "room-b-1", roomToken: "room-b" }));

      await roomBAdopted.promise;
      expect(delivered).toEqual(["room-a-1", "room-b-1"]);
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({ id: "room-a-2", laneKey: "room:room-a" }),
      ]);

      roomADelivery.resolve();
      await secondRoomAAdopted.promise;
      await spool.waitForIdle();
      expect(delivered).toEqual(["room-a-1", "room-b-1", "room-a-2"]);
    } finally {
      roomADelivery.resolve();
      await spool.stop();
    }
  });

  it("caps active room deliveries after durable adoption across repeated pumps", async () => {
    const deliveryGate = Promise.withResolvers<void>();
    const capacityAdopted = Promise.withResolvers<void>();
    const allAdopted = Promise.withResolvers<void>();
    let adoptedDeliveries = 0;
    let activeDeliveries = 0;
    let maxActiveDeliveries = 0;
    const deliver = vi.fn(async (_message, lifecycle) => {
      activeDeliveries += 1;
      maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
      await lifecycle.onAdopted();
      adoptedDeliveries += 1;
      if (adoptedDeliveries === 32) {
        capacityAdopted.resolve();
      } else if (adoptedDeliveries === 33) {
        allAdopted.resolve();
      }
      try {
        await deliveryGate.promise;
      } finally {
        activeDeliveries -= 1;
      }
    });
    const spool = startSpool(queue, deliver);

    try {
      for (let index = 0; index < 33; index += 1) {
        await spool.receive(
          createRawEvent({
            messageId: `room-delivery-${index}`,
            roomToken: `room-${index}`,
          }),
        );
      }

      await capacityAdopted.promise;
      expect(deliver).toHaveBeenCalledTimes(32);
      expect(maxActiveDeliveries).toBe(32);
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({ id: "room-delivery-32", laneKey: "room:room-32" }),
      ]);

      deliveryGate.resolve();
      await allAdopted.promise;
      await spool.waitForIdle();
      expect(deliver).toHaveBeenCalledTimes(33);
      expect(maxActiveDeliveries).toBe(32);
    } finally {
      deliveryGate.resolve();
      await spool.stop();
    }
  });

  it("keeps the claim until adoption finalization reaches its terminal callback", async () => {
    let adopt: (() => void | Promise<void>) | undefined;
    const deliver = vi.fn(async (_message, lifecycle) => {
      lifecycle.onAdoptionFinalizing();
      adopt = lifecycle.onAdopted;
    });
    await withSpool(startSpool(queue, deliver), async (spool) => {
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
  });

  it.each([
    {
      kind: "text",
      body: createRawEvent({ messageId: "msg-restart", text: "ordinary text" }),
      id: "msg-restart",
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
      id: "4242",
      lane: "room:redacted-room-token",
      message: {
        messageId: "4242",
        roomToken: "redacted-room-token",
        attachment: expect.objectContaining({ fileId: "9001" }),
      },
    },
  ])("recovers $kind in its original lane exactly once", async ({ body, id, lane, message }) => {
    const interrupted = startSpool(queue, deferredDelivery());
    await receive(interrupted, body);
    await expectClaim(id, lane, body);
    await interrupted.stop();
    const deliver = adoptedDelivery();
    await withSpool(startSpool(queue, deliver), async (spool) => {
      await spool.waitForIdle();
      await receive(spool, body);
      expect(deliver).toHaveBeenCalledTimes(1);
      expectDelivered(deliver, message);
    });
  });

  it.each([
    {
      kind: "file_shared",
      body: createFileSharedActivityBody(),
      message: {
        messageId: "4242",
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
      message: {
        messageId: "4250",
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
  ])("durably admits $kind activities", async ({ body, message }) => {
    const deliver = deferredDelivery();
    await withSpool(startSpool(queue, deliver), async (spool) => {
      await receive(spool, body);
      await expectClaim(message.messageId, "room:redacted-room-token", body);
      expectDelivered(deliver, {
        ...message,
        roomToken: "redacted-room-token",
        senderId: "users/alice",
        senderName: "Alice",
      });
    });
  });

  it("admits a Talk file share with a numeric byte size", async () => {
    const deliver = vi.fn<NextcloudTalkIngressDeliver>(async () => {});
    await withSpool(startSpool(queue, deliver), async (spool) => {
      await receive(spool, createFileSharedActivityBody({ fileSize: 1_234_567 }));
      expectDelivered(deliver, {
        attachment: expect.objectContaining({ declaredSizeBytes: 1_234_567 }),
      });
    });
  });

  it("bounds malformed file metadata as an unavailable attachment", async () => {
    const body = activityBody({
      id: "4245",
      content: JSON.stringify({ message: "{file}", parameters: { file: { type: "file" } } }),
    });
    const deliver = vi.fn<NextcloudTalkIngressDeliver>(async () => {});
    await withSpool(startSpool(queue, deliver), async (spool) => {
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
  });

  it("keeps malformed normal-message activities without a file parameter ignored", async () => {
    const deliver = vi.fn();
    await withSpool(startSpool(queue, deliver), async (spool) => {
      await expectIgnored(spool, activityBody({ id: "4246", content: "{not-json" }), deliver);
    });
  });

  it.each([
    { name: "participant_joined", message: "Alice joined the conversation", parameters: {} },
    {
      name: "object_shared",
      message: "{object}",
      parameters: { object: { type: "deck-card", id: "redacted" } },
    },
  ])(
    "keeps unrelated Talk Activity $name events ignored",
    async ({ name, message, parameters }) => {
      const body = activityBody({
        id: "4243",
        name,
        content: JSON.stringify({ message, parameters }),
      });
      const deliver = vi.fn();
      const log = vi.fn();
      await withSpool(startSpool(queue, deliver, log), async (spool) => {
        await expectIgnored(spool, body, deliver);
        expect(log).toHaveBeenCalledWith(
          "nextcloud-talk: ignored non-message webhook event (type=Activity objectType=Note)",
        );
      });
    },
  );

  it("logs non-message events before they consume the message id", async () => {
    const deliver = vi.fn();
    const log = vi.fn();
    await withSpool(startSpool(queue, deliver, log), async (spool) => {
      const fileShare = JSON.stringify({
        type: "Create",
        actor: { type: "Person", id: "alice", name: "Alice" },
        object: {
          type: "Document",
          id: "file-1",
          name: "report.pdf",
          content: "",
          mediaType: "application/pdf",
        },
        target: { type: "Collection", id: "room-1", name: "Room 1" },
      });
      await expectIgnored(spool, fileShare, deliver);
      expect(log).toHaveBeenCalledWith(
        "nextcloud-talk: ignored non-message webhook event (type=Create objectType=Document)",
      );
    });
  });
});
