import { describe, expect, it, vi } from "vitest";
import { runArchiveCleanupSweep } from "./channel-cleanup.js";

describe("msteams archive deleted-channel cleanup", () => {
  it("prunes only archives whose Teams channel is confirmed deleted", async () => {
    const pruneConversation = vi.fn(async () => ({
      removed: true,
      conversationId: "19:deleted@thread.tacv2",
      removedMessages: 2,
      removedAttachments: 1,
    }));
    const getAccessToken = vi.fn(async () => "graph-token");
    const channelExists = vi.fn(
      async ({ channelId }: { channelId: string }) => channelId !== "channel-deleted",
    );
    const resolveGraphTeamId = vi.fn(
      async ({ archive }: { archive: { teamId?: string; channelId?: string } }) =>
        archive.teamId === "runtime-team-key" && archive.channelId === "channel-deleted"
          ? "00000000-0000-0000-0000-000000000001"
          : (archive.teamId ?? null),
    );

    const result = await runArchiveCleanupSweep({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      store: {
        listChannelArchives: async () => [
          {
            archiveKey: "a",
            conversationId: "19:deleted@thread.tacv2",
            messageFile: "messages/a.jsonl",
            messageCount: 2,
            createdAt: 1,
            updatedAt: 2,
            conversationType: "channel",
            teamId: "runtime-team-key",
            channelId: "channel-deleted",
          },
          {
            archiveKey: "b",
            conversationId: "19:active@thread.tacv2",
            messageFile: "messages/b.jsonl",
            messageCount: 1,
            createdAt: 1,
            updatedAt: 2,
            conversationType: "channel",
            teamId: "00000000-0000-0000-0000-000000000002",
            channelId: "channel-active",
          },
          {
            archiveKey: "c",
            conversationId: "19:missing@thread.tacv2",
            messageFile: "messages/c.jsonl",
            messageCount: 1,
            createdAt: 1,
            updatedAt: 2,
            conversationType: "channel",
            teamId: "team-1",
          },
        ],
        pruneConversation,
      },
      getAccessToken,
      channelExists,
      resolveGraphTeamId,
    });

    expect(result).toEqual({
      scanned: 3,
      pruned: 1,
      skipped: 1,
    });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(resolveGraphTeamId).toHaveBeenCalledTimes(2);
    expect(resolveGraphTeamId).toHaveBeenCalledWith({
      accessToken: "graph-token",
      archive: expect.objectContaining({
        teamId: "runtime-team-key",
        channelId: "channel-deleted",
      }),
    });
    expect(channelExists).toHaveBeenCalledTimes(2);
    expect(pruneConversation).toHaveBeenCalledWith("19:deleted@thread.tacv2");
  });

  it("keeps archives when Graph checks fail", async () => {
    const pruneConversation = vi.fn();

    const result = await runArchiveCleanupSweep({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      store: {
        listChannelArchives: async () => [
          {
            archiveKey: "a",
            conversationId: "19:alerts@thread.tacv2",
            messageFile: "messages/a.jsonl",
            messageCount: 1,
            createdAt: 1,
            updatedAt: 2,
            conversationType: "channel",
            teamId: "00000000-0000-0000-0000-000000000001",
            channelId: "channel-1",
          },
        ],
        pruneConversation,
      },
      getAccessToken: async () => "graph-token",
      channelExists: async () => {
        throw new Error("Graph 503");
      },
    });

    expect(result).toEqual({
      scanned: 1,
      pruned: 0,
      skipped: 1,
    });
    expect(pruneConversation).not.toHaveBeenCalled();
  });

  it("uses tenant-specific tokens and caches Graph team resolution per team", async () => {
    const pruneConversation = vi.fn();
    const getAccessToken = vi.fn(async (tenantId?: string) => `token:${tenantId ?? "default"}`);
    const resolveGraphTeamId = vi.fn(async () => "00000000-0000-0000-0000-000000000999");
    const channelExists = vi.fn(async () => true);

    const result = await runArchiveCleanupSweep({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      store: {
        listChannelArchives: async () => [
          {
            archiveKey: "a",
            conversationId: "19:ops-1@thread.tacv2",
            messageFile: "messages/a.jsonl",
            messageCount: 1,
            createdAt: 1,
            updatedAt: 2,
            conversationType: "channel",
            tenantId: "tenant-a",
            teamId: "runtime-team-key",
            channelId: "channel-1",
          },
          {
            archiveKey: "b",
            conversationId: "19:ops-2@thread.tacv2",
            messageFile: "messages/b.jsonl",
            messageCount: 1,
            createdAt: 1,
            updatedAt: 2,
            conversationType: "channel",
            tenantId: "tenant-a",
            teamId: "runtime-team-key",
            channelId: "channel-2",
          },
          {
            archiveKey: "c",
            conversationId: "19:ops-3@thread.tacv2",
            messageFile: "messages/c.jsonl",
            messageCount: 1,
            createdAt: 1,
            updatedAt: 2,
            conversationType: "channel",
            tenantId: "tenant-b",
            teamId: "runtime-team-key-b",
            channelId: "channel-3",
          },
        ],
        pruneConversation,
      },
      defaultTenantId: "tenant-default",
      getAccessToken,
      channelExists,
      resolveGraphTeamId,
    });

    expect(result).toEqual({
      scanned: 3,
      pruned: 0,
      skipped: 0,
    });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(getAccessToken).toHaveBeenNthCalledWith(1, "tenant-a");
    expect(getAccessToken).toHaveBeenNthCalledWith(2, "tenant-b");
    expect(resolveGraphTeamId).toHaveBeenCalledTimes(2);
    expect(channelExists).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accessToken: "token:tenant-a", channelId: "channel-1" }),
    );
    expect(channelExists).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accessToken: "token:tenant-a", channelId: "channel-2" }),
    );
    expect(channelExists).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ accessToken: "token:tenant-b", channelId: "channel-3" }),
    );
    expect(pruneConversation).not.toHaveBeenCalled();
  });
});
