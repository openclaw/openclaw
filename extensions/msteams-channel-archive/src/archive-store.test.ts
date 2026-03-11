import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArchiveStore } from "./archive-store.js";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe("msteams channel archive store", () => {
  let tempDir: string;
  let store: ReturnType<typeof createArchiveStore>;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "msteams-archive-"));
    store = createArchiveStore({ stateDir: tempDir, logger });
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("archives a channel message and avoids duplicate message ids", async () => {
    const mediaDir = path.join(tempDir, "fixtures");
    await fs.promises.mkdir(mediaDir, { recursive: true });
    const mediaPath = path.join(mediaDir, "diagram.png");
    await fs.promises.writeFile(mediaPath, Buffer.from("png-data"));

    const first = await store.archiveMessage({
      conversationId: "19:alerts@thread.tacv2",
      messageId: "msg-1",
      timestamp: 1710000000000,
      content: "Please review the incident screenshot",
      rawBody: "Please review the incident screenshot",
      chatType: "channel",
      conversationType: "channel",
      teamId: "team-1",
      channelId: "channel-1",
      channelName: "alerts",
      senderId: "user-1",
      senderName: "Alice",
      mediaPaths: [mediaPath],
      mediaTypes: ["image/png"],
    });
    const second = await store.archiveMessage({
      conversationId: "19:alerts@thread.tacv2",
      messageId: "msg-1",
      timestamp: 1710000000001,
      content: "duplicate should be ignored",
      rawBody: "duplicate should be ignored",
      chatType: "channel",
      conversationType: "channel",
      senderId: "user-1",
      senderName: "Alice",
      mediaPaths: [mediaPath],
      mediaTypes: ["image/png"],
    });

    expect(second).toEqual(first);
    expect(first.attachments).toHaveLength(1);
    expect(first.attachments[0]?.storedPath).toContain("attachments/");

    const found = await store.getMessage({
      conversationId: "19:alerts@thread.tacv2",
      messageId: "msg-1",
    });
    expect(found?.channelName).toBe("alerts");
    expect(found?.attachments[0]?.missing).toBe(false);
  });

  it("searches messages, threads, and attachments", async () => {
    await store.archiveMessage({
      conversationId: "19:alerts@thread.tacv2",
      messageId: "root-1",
      timestamp: 1710000000000,
      content: "Incident root thread",
      rawBody: "Incident root thread",
      chatType: "channel",
      conversationType: "channel",
      senderId: "user-1",
      senderName: "Alice",
      mediaPaths: [],
      mediaTypes: [],
    });

    const mediaPath = path.join(tempDir, "reply.txt");
    await fs.promises.writeFile(mediaPath, "reply attachment");
    await store.archiveMessage({
      conversationId: "19:alerts@thread.tacv2",
      messageId: "reply-1",
      replyToId: "root-1",
      timestamp: 1710000001000,
      content: "Incident reply with file",
      rawBody: "Incident reply with file",
      chatType: "channel",
      conversationType: "channel",
      senderId: "user-2",
      senderName: "Bob",
      mediaPaths: [mediaPath],
      mediaTypes: ["text/plain"],
    });

    const search = await store.searchMessages({
      conversationId: "19:alerts@thread.tacv2",
      query: "incident",
      limit: 10,
    });
    expect(search).toHaveLength(2);
    expect(search[0]?.messageId).toBe("reply-1");

    const thread = await store.getThread({
      conversationId: "19:alerts@thread.tacv2",
      rootMessageId: "root-1",
      limit: 10,
    });
    expect(thread.map((item) => item.messageId)).toEqual(["root-1", "reply-1"]);

    const attachments = await store.searchAttachments({
      conversationId: "19:alerts@thread.tacv2",
      query: "reply",
      limit: 10,
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.attachment.mime).toBe("text/plain");
  });

  it("prunes deleted channel archives and only removes orphaned attachments", async () => {
    const sharedSource = path.join(tempDir, "shared.txt");
    const uniqueSource = path.join(tempDir, "unique.txt");
    await fs.promises.writeFile(sharedSource, "shared attachment");
    await fs.promises.writeFile(uniqueSource, "unique attachment");

    await store.archiveMessage({
      conversationId: "19:alerts@thread.tacv2",
      messageId: "alerts-1",
      timestamp: 1710000000000,
      content: "alerts message",
      rawBody: "alerts message",
      chatType: "channel",
      conversationType: "channel",
      teamId: "team-1",
      channelId: "channel-1",
      mediaPaths: [sharedSource],
      mediaTypes: ["text/plain"],
    });

    await store.archiveMessage({
      conversationId: "19:alerts@thread.tacv2",
      messageId: "alerts-2",
      timestamp: 1710000001000,
      content: "alerts follow-up",
      rawBody: "alerts follow-up",
      chatType: "channel",
      conversationType: "channel",
      teamId: "team-1",
      channelId: "channel-1",
      mediaPaths: [uniqueSource],
      mediaTypes: ["text/plain"],
    });

    await store.archiveMessage({
      conversationId: "19:incidents@thread.tacv2",
      messageId: "incidents-1",
      timestamp: 1710000002000,
      content: "incident message",
      rawBody: "incident message",
      chatType: "channel",
      conversationType: "channel",
      teamId: "team-1",
      channelId: "channel-2",
      mediaPaths: [sharedSource],
      mediaTypes: ["text/plain"],
    });

    const beforePrune = await store.searchAttachments({ query: "txt", limit: 10 });
    expect(beforePrune).toHaveLength(3);

    const sharedAttachmentPath = (
      await store.getMessage({
        conversationId: "19:alerts@thread.tacv2",
        messageId: "alerts-1",
      })
    )?.attachments[0]?.storedPath;
    const uniqueAttachmentPath = (
      await store.getMessage({
        conversationId: "19:alerts@thread.tacv2",
        messageId: "alerts-2",
      })
    )?.attachments[0]?.storedPath;
    expect(sharedAttachmentPath).toBeTruthy();
    expect(uniqueAttachmentPath).toBeTruthy();
    expect(sharedAttachmentPath).not.toBe(uniqueAttachmentPath);

    const pruneResult = await store.pruneConversation("19:alerts@thread.tacv2");
    expect(pruneResult).toMatchObject({
      removed: true,
      conversationId: "19:alerts@thread.tacv2",
      removedMessages: 2,
      removedAttachments: 1,
    });

    expect(
      await store.getMessage({
        conversationId: "19:alerts@thread.tacv2",
        messageId: "alerts-1",
      }),
    ).toBeNull();

    const remainingAttachments = await store.searchAttachments({ query: "txt", limit: 10 });
    expect(remainingAttachments).toHaveLength(1);
    expect(remainingAttachments[0]?.conversationId).toBe("19:incidents@thread.tacv2");
    expect(remainingAttachments[0]?.attachment.storedPath).toBe(sharedAttachmentPath);
    expect(
      await fs.promises.stat(
        path.join(tempDir, "channel-archive", "msteams", sharedAttachmentPath as string),
      ),
    ).toBeTruthy();
    await expect(
      fs.promises.stat(
        path.join(tempDir, "channel-archive", "msteams", uniqueAttachmentPath as string),
      ),
    ).rejects.toThrow();
  });
});
