import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createThread,
  getThread,
  getThreadByMessage,
  listThreads,
  subscribeToThread,
  unsubscribeFromThread,
  updateSubscription,
  markThreadRead,
  getThreadUnreadCount,
  archiveThread,
  unarchiveThread,
  updateThreadTitle,
  getThreadNotificationTargets,
  autoSubscribeOnReply,
} from "./manager.js";

const mockDbClient = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
};

vi.mock("../db/client.js", () => ({
  getChatDbClient: () => mockDbClient,
  REDIS_KEYS: {
    pubsubChannel: (channelId: string) => `pubsub:channel:${channelId}`,
  },
  toJsonb: (v: unknown) => JSON.stringify(v),
  fromJsonb: <T>(v: string | null): T | null => {
    if (v == null) {
      return null;
    }
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  },
}));

describe("thread manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbClient.execute.mockResolvedValue({ rowCount: 1 });
    mockDbClient.query.mockResolvedValue([]);
  });

  describe("createThread", () => {
    it("should create a new thread and subscribe creator", async () => {
      const thread = await createThread({
        channelId: "chan_456",
        parentMessageId: "msg_789",
        creatorId: "user1",
      });

      expect(thread.channelId).toBe("chan_456");
      expect(thread.parentMessageId).toBe("msg_789");
      expect(thread.threadId).toMatch(/^thread_/);
      expect(thread.messageCount).toBe(0);
      expect(thread.archived).toBe(false);
      expect(thread.subscribers).toHaveLength(1);
      expect(thread.subscribers[0].agentId).toBe("user1");

      // Should have inserted thread + subscribed creator
      expect(mockDbClient.execute).toHaveBeenCalledTimes(2);
    });

    it("should support optional title", async () => {
      const thread = await createThread({
        channelId: "chan_456",
        parentMessageId: "msg_789",
        creatorId: "user1",
        title: "Discussion about feature X",
      });

      expect(thread.title).toBe("Discussion about feature X");
    });
  });

  describe("getThread", () => {
    it("should retrieve thread with subscribers", async () => {
      const now = new Date();
      mockDbClient.queryOne.mockResolvedValueOnce({
        thread_id: "thread_123",
        channel_id: "chan_456",
        parent_message_id: "msg_789",
        title: null,
        message_count: 5,
        last_message_at: now,
        created_at: now,
        archived: false,
      });
      mockDbClient.query.mockResolvedValueOnce([
        {
          thread_id: "thread_123",
          agent_id: "agent1",
          notification_level: "all",
          subscribed_at: now,
          last_read_at: null,
        },
      ]);

      const thread = await getThread("thread_123");

      expect(thread?.threadId).toBe("thread_123");
      expect(thread?.messageCount).toBe(5);
      expect(thread?.subscribers).toHaveLength(1);
    });

    it("should return null for non-existent thread", async () => {
      mockDbClient.queryOne.mockResolvedValueOnce(null);

      const thread = await getThread("nonexistent");

      expect(thread).toBeNull();
    });
  });

  describe("getThreadByMessage", () => {
    it("should find thread by parent message ID", async () => {
      const now = new Date();
      mockDbClient.queryOne.mockResolvedValueOnce({
        thread_id: "thread_123",
        channel_id: "chan_456",
        parent_message_id: "msg_789",
        title: null,
        message_count: 0,
        last_message_at: null,
        created_at: now,
        archived: false,
      });
      mockDbClient.query.mockResolvedValueOnce([]);

      const thread = await getThreadByMessage("msg_789");

      expect(thread?.threadId).toBe("thread_123");
    });
  });

  describe("listThreads", () => {
    it("should return threads for a channel", async () => {
      const now = new Date();
      mockDbClient.query
        .mockResolvedValueOnce([
          {
            thread_id: "thread_1",
            channel_id: "chan_456",
            parent_message_id: "msg_1",
            title: null,
            message_count: 10,
            last_message_at: now,
            created_at: now,
            archived: false,
          },
          {
            thread_id: "thread_2",
            channel_id: "chan_456",
            parent_message_id: "msg_2",
            title: null,
            message_count: 5,
            last_message_at: now,
            created_at: now,
            archived: false,
          },
        ])
        .mockResolvedValueOnce([]) // subscribers for thread_1
        .mockResolvedValueOnce([]); // subscribers for thread_2

      const threads = await listThreads("chan_456");

      expect(threads).toHaveLength(2);
    });

    it("should support limit and offset", async () => {
      mockDbClient.query.mockResolvedValueOnce([]);

      await listThreads("chan_456", { limit: 10, offset: 5 });

      expect(mockDbClient.query).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT"),
        expect.arrayContaining(["chan_456", 10, 5]),
      );
    });
  });

  describe("subscribeToThread", () => {
    it("should subscribe agent with ON CONFLICT upsert", async () => {
      await subscribeToThread("thread_123", "agent1", "all");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO thread_subscribers"),
        expect.arrayContaining(["thread_123", "agent1", "all"]),
      );
    });
  });

  describe("unsubscribeFromThread", () => {
    it("should delete subscriber record", async () => {
      await unsubscribeFromThread("thread_123", "agent1");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM thread_subscribers"),
        expect.arrayContaining(["thread_123", "agent1"]),
      );
    });
  });

  describe("updateSubscription", () => {
    it("should update notification level", async () => {
      await updateSubscription("thread_123", "agent1", "mentions");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE thread_subscribers"),
        expect.arrayContaining(["mentions", "thread_123", "agent1"]),
      );
    });
  });

  describe("markThreadRead", () => {
    it("should update last_read_at", async () => {
      await markThreadRead("thread_123", "agent1");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("last_read_at = NOW()"),
        expect.arrayContaining(["thread_123", "agent1"]),
      );
    });
  });

  describe("getThreadUnreadCount", () => {
    it("should return unread message count", async () => {
      mockDbClient.queryOne.mockResolvedValueOnce({ count: "7" });

      const count = await getThreadUnreadCount("thread_123", "agent1");

      expect(count).toBe(7);
    });

    it("should return 0 when no unread", async () => {
      mockDbClient.queryOne.mockResolvedValueOnce({ count: "0" });

      const count = await getThreadUnreadCount("thread_123", "agent1");

      expect(count).toBe(0);
    });
  });

  describe("archiveThread", () => {
    it("should set archived to true", async () => {
      await archiveThread("thread_123");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("archived = TRUE"),
        ["thread_123"],
      );
    });
  });

  describe("unarchiveThread", () => {
    it("should set archived to false", async () => {
      await unarchiveThread("thread_123");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("archived = FALSE"),
        ["thread_123"],
      );
    });
  });

  describe("updateThreadTitle", () => {
    it("should update thread title", async () => {
      await updateThreadTitle("thread_123", "New Title");

      expect(mockDbClient.execute).toHaveBeenCalledWith(expect.stringContaining("title = $1"), [
        "New Title",
        "thread_123",
      ]);
    });
  });

  describe("getThreadNotificationTargets", () => {
    it("should return subscribers with notification level 'all'", async () => {
      const now = new Date();
      mockDbClient.queryOne.mockResolvedValueOnce({
        thread_id: "thread_123",
        channel_id: "chan_456",
        parent_message_id: "msg_789",
        title: null,
        message_count: 0,
        last_message_at: null,
        created_at: now,
        archived: false,
      });
      mockDbClient.query.mockResolvedValueOnce([
        {
          thread_id: "thread_123",
          agent_id: "agent1",
          notification_level: "all",
          subscribed_at: now,
          last_read_at: null,
        },
        {
          thread_id: "thread_123",
          agent_id: "agent2",
          notification_level: "none",
          subscribed_at: now,
          last_read_at: null,
        },
      ]);

      const targets = await getThreadNotificationTargets("thread_123");

      expect(targets).toContain("agent1");
      expect(targets).not.toContain("agent2");
    });

    it("should exclude specified agent", async () => {
      const now = new Date();
      mockDbClient.queryOne.mockResolvedValueOnce({
        thread_id: "thread_123",
        channel_id: "chan_456",
        parent_message_id: "msg_789",
        title: null,
        message_count: 0,
        last_message_at: null,
        created_at: now,
        archived: false,
      });
      mockDbClient.query.mockResolvedValueOnce([
        {
          thread_id: "thread_123",
          agent_id: "agent1",
          notification_level: "all",
          subscribed_at: now,
          last_read_at: null,
        },
        {
          thread_id: "thread_123",
          agent_id: "agent2",
          notification_level: "all",
          subscribed_at: now,
          last_read_at: null,
        },
      ]);

      const targets = await getThreadNotificationTargets("thread_123", "agent1");

      expect(targets).not.toContain("agent1");
      expect(targets).toContain("agent2");
    });
  });

  describe("autoSubscribeOnReply", () => {
    it("should subscribe agent if not already subscribed", async () => {
      const now = new Date();
      // getThread mock
      mockDbClient.queryOne.mockResolvedValueOnce({
        thread_id: "thread_123",
        channel_id: "chan_456",
        parent_message_id: "msg_789",
        title: null,
        message_count: 0,
        last_message_at: null,
        created_at: now,
        archived: false,
      });
      mockDbClient.query.mockResolvedValueOnce([]); // no existing subscribers

      await autoSubscribeOnReply("thread_123", "new_agent");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO thread_subscribers"),
        expect.arrayContaining(["thread_123", "new_agent", "all"]),
      );
    });

    it("should not duplicate subscription", async () => {
      const now = new Date();
      mockDbClient.queryOne.mockResolvedValueOnce({
        thread_id: "thread_123",
        channel_id: "chan_456",
        parent_message_id: "msg_789",
        title: null,
        message_count: 0,
        last_message_at: null,
        created_at: now,
        archived: false,
      });
      mockDbClient.query.mockResolvedValueOnce([
        {
          thread_id: "thread_123",
          agent_id: "agent1",
          notification_level: "all",
          subscribed_at: now,
          last_read_at: null,
        },
      ]);

      await autoSubscribeOnReply("thread_123", "agent1");

      // Should not insert again (only getThread queries, no execute)
      expect(mockDbClient.execute).not.toHaveBeenCalled();
    });
  });
});
