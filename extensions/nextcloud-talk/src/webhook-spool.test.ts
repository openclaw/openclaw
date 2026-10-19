// Nextcloud Talk durable ingress tests cover recovery, tombstones, identity, and shutdown.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function withQueue<T>(fn: (queue: NextcloudTalkIngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nextcloud-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<NextcloudTalkIngressPayload>({
    channelId: "nextcloud-talk",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Nextcloud Talk durable ingress", () => {
  it("accepts file metadata without the optional hide-download flag", () => {
    const body = createFileSharedActivityBody();
    const envelope = JSON.parse(body) as { object: { content: string } };
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
    await withQueue(async (queue) => {
      let releaseEntries: (() => void) | undefined;
      const entries = vi.fn(
        () =>
          new Promise<[]>((resolve) => {
            releaseEntries = () => resolve([]);
          }),
      );
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
      releaseEntries?.();

      await expect(receiving).resolves.toBe("accepted");
      await stopping;
      expect(prune).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(await queue.listPending({ limit: "all" })).toHaveLength(1);
    });
  });

  it("migrates the shipped replay guard window into completion tombstones", async () => {
    await withQueue(async (queue) => {
      const seenAt = Date.now();
      const store = {
        entries: vi.fn(async () => [{ value: { key: "test-room:msg-legacy", seenAt } }]),
        clear: vi.fn(async () => {}),
      };

      await expect(migrateNextcloudTalkLegacyReplayState({ queue, store })).resolves.toBe(1);
      expect((await queue.enqueue("msg-legacy", {} as NextcloudTalkIngressPayload)).kind).toBe(
        "completed",
      );
      expect(store.clear).toHaveBeenCalledTimes(1);
    });
  });

  it("propagates append failure without live-dispatch fallback", async () => {
    await withQueue(async (queue) => {
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
  });

  it("recovers an uncompleted webhook with a fresh drain exactly once", async () => {
    await withQueue(async (queue) => {
      const interruptedDeliver = vi.fn(async (_message, lifecycle) => {
        lifecycle.onDeferred();
      });
      const interrupted = startSpool(queue, interruptedDeliver);
      await interrupted.receive(createRawEvent({ messageId: "msg-restart" }));
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);
      await interrupted.stop();

      const recoveredDeliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = startSpool(queue, recoveredDeliver);
      try {
        await recovered.waitForIdle();
        expect(recoveredDeliver).toHaveBeenCalledTimes(1);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("drains other rooms while keeping unadopted same-room deliveries ordered", async () => {
    await withQueue(async (queue) => {
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
  });

  it("caps active room deliveries after durable adoption across repeated pumps", async () => {
    await withQueue(async (queue) => {
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
  });

  it("stores the exact raw envelope in the room lane", async () => {
    await withQueue(async (queue) => {
      const rawEvent = createRawEvent({ messageId: "msg-raw", roomToken: "test-room-token" });
      await withSpool(
        startSpool(queue, async (_message, lifecycle) => {
          lifecycle.onDeferred();
        }),
        async (spool) => {
          await spool.receive(rawEvent);
          await spool.waitForIdle();
          expect(await queue.listClaims()).toEqual([
            expect.objectContaining({
              id: "msg-raw",
              laneKey: "room:test-room-token",
              payload: expect.objectContaining({ rawEvent }),
            }),
          ]);
        },
      );
    });
  });

  it("continues delivering ordinary Create Note text messages", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async () => {});
      await withSpool(startSpool(queue, deliver), async (spool) => {
        await expect(
          spool.receive(
            createRawEvent({
              messageId: "msg-text-regression",
              roomToken: "room-text-regression",
              text: "ordinary text",
            }),
          ),
        ).resolves.toBe("accepted");
        await spool.waitForIdle();
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: "msg-text-regression",
            roomToken: "room-text-regression",
            text: "ordinary text",
            mediaType: "text/plain",
          }),
          expect.any(Object),
        );
      });
    });
  });

  it("keeps the claim until adoption finalization reaches its terminal callback", async () => {
    await withQueue(async (queue) => {
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
  });

  it("rejects a duplicate file_shared activity after completion", async () => {
    await withQueue(async (queue) => {
      const body = createFileSharedActivityBody();
      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      await withSpool(startSpool(queue, deliver), async (spool) => {
        await expect(spool.receive(body)).resolves.toBe("accepted");
        await spool.waitForIdle();
        await expect(spool.receive(body)).resolves.toBe("accepted");
        await spool.waitForIdle();
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: "4242",
            roomToken: "redacted-room-token",
            attachment: expect.objectContaining({ fileId: "9001" }),
          }),
          expect.any(Object),
        );
      });
    });
  });

  it("replays an interrupted file_shared activity in its original room lane", async () => {
    await withQueue(async (queue) => {
      const body = createFileSharedActivityBody();
      const interruptedDeliver = vi.fn(async (_message, lifecycle) => {
        lifecycle.onDeferred();
      });
      const interrupted = startSpool(queue, interruptedDeliver);
      await interrupted.receive(body);
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toEqual([
        expect.objectContaining({
          id: "4242",
          laneKey: "room:redacted-room-token",
        }),
      ]);
      await interrupted.stop();

      const recoveredDeliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = startSpool(queue, recoveredDeliver);
      try {
        await recovered.waitForIdle();
        expect(recoveredDeliver).toHaveBeenCalledTimes(1);
        expect(recoveredDeliver).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: "4242",
            roomToken: "redacted-room-token",
            attachment: expect.objectContaining({ fileId: "9001" }),
          }),
          expect.any(Object),
        );
      } finally {
        await recovered.stop();
      }
    });
  });

  it("durably admits Talk file_shared activities", async () => {
    await withQueue(async (queue) => {
      const body = createFileSharedActivityBody();
      const deliver = vi.fn(async (_message, lifecycle) => {
        lifecycle.onDeferred();
      });
      await withSpool(startSpool(queue, deliver), async (spool) => {
        await expect(spool.receive(body)).resolves.toBe("accepted");
        await spool.waitForIdle();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "4242",
            laneKey: "room:redacted-room-token",
            payload: expect.objectContaining({ rawEvent: body }),
          }),
        ]);
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: "4242",
            roomToken: "redacted-room-token",
            roomName: "Receipts",
            senderId: "users/alice",
            senderName: "Alice",
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
          }),
          expect.any(Object),
        );
      });
    });
  });

  it("admits a Talk file share with a numeric byte size", async () => {
    await withQueue(async (queue) => {
      const body = createFileSharedActivityBody({ fileSize: 1_234_567 });
      const deliver = vi.fn<NextcloudTalkIngressDeliver>(async () => {});
      await withSpool(startSpool(queue, deliver), async (spool) => {
        await expect(spool.receive(body)).resolves.toBe("accepted");
        await spool.waitForIdle();
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({
            attachment: expect.objectContaining({ declaredSizeBytes: 1_234_567 }),
          }),
          expect.any(Object),
        );
      });
    });
  });

  it("durably admits canonical native Talk voice-message activities", async () => {
    await withQueue(async (queue) => {
      const body = createVoiceMessageActivityBody();
      const deliver = vi.fn(async (_message, lifecycle) => {
        lifecycle.onDeferred();
      });
      await withSpool(startSpool(queue, deliver), async (spool) => {
        await expect(spool.receive(body)).resolves.toBe("accepted");
        await spool.waitForIdle();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "4250",
            laneKey: "room:redacted-room-token",
            payload: expect.objectContaining({ rawEvent: body }),
          }),
        ]);
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: "4250",
            roomToken: "redacted-room-token",
            roomName: "Voice notes",
            senderId: "users/alice",
            senderName: "Alice",
            text: "",
            attachment: {
              fileId: "9010",
              name: "voice-note.wav",
              mimeType: "audio/wav",
              declaredSizeBytes: 557_804,
              shareUrl: "https://nextcloud.example/s/redacted-voice-share-token",
              hideDownload: false,
            },
          }),
          expect.any(Object),
        );
      });
    });
  });

  it("bounds malformed file metadata as an unavailable attachment", async () => {
    await withQueue(async (queue) => {
      const fixture = createFileSharedActivityBody();
      const payload = JSON.parse(fixture) as { object: { id: string; content: string } };
      payload.object.id = "4245";
      payload.object.content = JSON.stringify({
        message: "{file}",
        parameters: { file: { type: "file" } },
      });
      const body = JSON.stringify(payload);
      const deliver = vi.fn<NextcloudTalkIngressDeliver>(async () => {});
      await withSpool(startSpool(queue, deliver), async (spool) => {
        await expect(spool.receive(body)).resolves.toBe("accepted");
        await spool.waitForIdle();
        await expect(spool.receive(body)).resolves.toBe("accepted");
        await spool.waitForIdle();
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: "4245",
            text: "",
            attachmentIssue: "media_missing_metadata",
          }),
          expect.any(Object),
        );
        expect(deliver.mock.calls[0]?.[0]).not.toHaveProperty("attachment");
      });
    });
  });

  it("keeps malformed normal-message activities without a file parameter ignored", async () => {
    await withQueue(async (queue) => {
      const fixture = createFileSharedActivityBody();
      const payload = JSON.parse(fixture) as { object: { id: string; content: string } };
      payload.object.id = "4246";
      payload.object.content = "{not-json";
      const deliver = vi.fn();
      await withSpool(startSpool(queue, deliver), async (spool) => {
        await expect(spool.receive(JSON.stringify(payload))).resolves.toBe("ignored");
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
      });
    });
  });

  it("keeps unrelated Talk Activity events ignored", async () => {
    await withQueue(async (queue) => {
      const fixture = createFileSharedActivityBody();
      const payload = JSON.parse(fixture) as {
        object: { id: string; name: string; content: string };
      };
      payload.object.id = "4243";
      payload.object.name = "participant_joined";
      payload.object.content = JSON.stringify({
        message: "Alice joined the conversation",
        parameters: {},
      });
      const deliver = vi.fn();
      const log = vi.fn();
      await withSpool(startSpool(queue, deliver, log), async (spool) => {
        await expect(spool.receive(JSON.stringify(payload))).resolves.toBe("ignored");
        expect(log).toHaveBeenCalledWith(
          "nextcloud-talk: ignored non-message webhook event (type=Activity objectType=Note)",
        );
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
      });
    });
  });

  it("keeps Talk object_shared activities ignored", async () => {
    await withQueue(async (queue) => {
      const fixture = createFileSharedActivityBody();
      const payload = JSON.parse(fixture) as {
        object: { id: string; name: string; content: string };
      };
      payload.object.id = "4244";
      payload.object.name = "object_shared";
      payload.object.content = JSON.stringify({
        message: "{object}",
        parameters: { object: { type: "deck-card", id: "redacted" } },
      });
      const deliver = vi.fn();
      await withSpool(startSpool(queue, deliver), async (spool) => {
        await expect(spool.receive(JSON.stringify(payload))).resolves.toBe("ignored");
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
      });
    });
  });

  it("logs non-message events before they consume the message id", async () => {
    await withQueue(async (queue) => {
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
        await expect(spool.receive(fileShare)).resolves.toBe("ignored");
        expect(log).toHaveBeenCalledWith(
          "nextcloud-talk: ignored non-message webhook event (type=Create objectType=Document)",
        );
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
      });
    });
  });
});
