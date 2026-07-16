// WhatsApp durable ingress drain adapter: complete-on-return and failure propagation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it } from "vitest";
import {
  createWhatsAppIngressDrain,
  type WhatsAppDurableInboundCompletedMetadata,
  type WhatsAppDurableInboundMetadata,
  type WhatsAppDurableInboundPayload,
} from "./durable-receive.js";

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-durable-"));
  try {
    return await fn(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function payload(id: string): WhatsAppDurableInboundPayload {
  return {
    message: {
      key: { remoteJid: "1@s.whatsapp.net", id, fromMe: false },
      message: { conversation: "hi" },
    },
    receivedAt: 1,
  };
}

describe("createWhatsAppIngressDrain", () => {
  it("releases claims when processClaimed throws (callback failure at-least-once)", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<
        WhatsAppDurableInboundPayload,
        WhatsAppDurableInboundMetadata,
        WhatsAppDurableInboundCompletedMetadata
      >({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      await queue.enqueue("msg-1", payload("msg-1"));

      const drain = createWhatsAppIngressDrain({
        queue,
        processClaimed: async () => {
          throw new Error("downstream callback rejected");
        },
      });

      await drain.drainOnce();
      await drain.waitForIdle();

      const status = await queue.enqueue("msg-1", payload("msg-1"));
      expect(status.kind).not.toBe("completed");
      const pending = await queue.listPending({ limit: "all" });
      expect(pending.some((row) => row.id === "msg-1")).toBe(true);
      drain.dispose();
    });
  });

  it("releases claims when processClaimed surfaces dedupe contention", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<
        WhatsAppDurableInboundPayload,
        WhatsAppDurableInboundMetadata,
        WhatsAppDurableInboundCompletedMetadata
      >({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      await queue.enqueue("msg-2", payload("msg-2"));

      const drain = createWhatsAppIngressDrain({
        queue,
        processClaimed: async () => {
          // monitor maps "inflight" contention to this throw for drain-owned claims.
          throw new Error("whatsapp inbound dedupe claim contended (inflight)");
        },
      });

      await drain.drainOnce();
      await drain.waitForIdle();

      const pending = await queue.listPending({ limit: "all" });
      expect(pending.some((row) => row.id === "msg-2")).toBe(true);
      const status = await queue.enqueue("msg-2", payload("msg-2"));
      expect(status.kind).not.toBe("completed");
      drain.dispose();
    });
  });

  it("tombstones after successful processClaimed return", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<
        WhatsAppDurableInboundPayload,
        WhatsAppDurableInboundMetadata,
        WhatsAppDurableInboundCompletedMetadata
      >({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      await queue.enqueue("msg-3", payload("msg-3"));

      const drain = createWhatsAppIngressDrain({
        queue,
        processClaimed: async () => {},
      });

      await drain.drainOnce();
      await drain.waitForIdle();

      const status = await queue.enqueue("msg-3", payload("msg-3"));
      expect(status.kind).toBe("completed");
      drain.dispose();
    });
  });

  it("releases claim and increments attempts when processClaimed surfaces flush failure", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<
        WhatsAppDurableInboundPayload,
        WhatsAppDurableInboundMetadata,
        WhatsAppDurableInboundCompletedMetadata
      >({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      await queue.enqueue("msg-flush-fail", payload("msg-flush-fail"));

      const drain = createWhatsAppIngressDrain({
        queue,
        processClaimed: async () => {
          throw new Error("downstream flush rejected");
        },
      });

      await drain.drainOnce();
      await drain.waitForIdle();

      const pending = await queue.listPending({ limit: "all" });
      const row = pending.find((entry) => entry.id === "msg-flush-fail");
      expect(row).toBeDefined();
      expect((row?.attempts ?? 0) >= 1).toBe(true);
      drain.dispose();
    });
  });
});
