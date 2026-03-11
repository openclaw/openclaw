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
});
