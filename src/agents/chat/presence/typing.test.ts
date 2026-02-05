import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  startTyping,
  stopTyping,
  getTypingAgents,
  getTypingState,
  isTyping,
  formatTypingText,
  subscribeToTyping,
  onMessageSent,
  refreshTyping,
} from "./typing.js";

const mockDbClient = {
  zadd: vi.fn(),
  zrem: vi.fn(),
  zrangebyscore: vi.fn(),
  zremrangebyscore: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  expire: vi.fn(),
  execute: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  queryOne: vi.fn(),
};

vi.mock("../db/client.js", () => ({
  getChatDbClient: () => mockDbClient,
  REDIS_KEYS: {
    typing: (channelId: string) => `typing:${channelId}`,
    pubsubChannel: (channelId: string) => `pubsub:channel:${channelId}`,
  },
  REDIS_TTL: {
    typing: 10,
    presence: 300,
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

describe("typing indicators", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbClient.zadd.mockResolvedValue(1);
    mockDbClient.zrem.mockResolvedValue(1);
    mockDbClient.expire.mockResolvedValue(undefined);
    mockDbClient.publish.mockResolvedValue(1);
    mockDbClient.execute.mockResolvedValue({ rowCount: 0 });
    mockDbClient.zremrangebyscore.mockResolvedValue(0);
  });

  describe("startTyping", () => {
    it("should add agent to typing sorted set", async () => {
      await startTyping("agent1", "chan_123");

      expect(mockDbClient.zadd).toHaveBeenCalledWith(
        "typing:chan_123",
        expect.any(Number),
        "agent1",
      );
    });

    it("should publish a typing event", async () => {
      await startTyping("agent1", "chan_123");

      expect(mockDbClient.publish).toHaveBeenCalledWith(
        "pubsub:channel:chan_123",
        expect.stringContaining("typing.update"),
      );
    });

    it("should support thread-specific typing", async () => {
      await startTyping("agent1", "chan_123", "thread_456");

      expect(mockDbClient.zadd).toHaveBeenCalledWith(
        "typing:chan_123",
        expect.any(Number),
        "agent1:thread_456",
      );
    });
  });

  describe("stopTyping", () => {
    it("should remove agent from typing sorted set", async () => {
      await stopTyping("agent1", "chan_123");

      expect(mockDbClient.zrem).toHaveBeenCalledWith("typing:chan_123", "agent1");
    });

    it("should publish stop typing event", async () => {
      await stopTyping("agent1", "chan_123");

      expect(mockDbClient.publish).toHaveBeenCalledWith(
        "pubsub:channel:chan_123",
        expect.any(String),
      );
    });
  });

  describe("getTypingAgents", () => {
    it("should return agents currently typing", async () => {
      mockDbClient.zrangebyscore.mockResolvedValueOnce(["agent1", "agent2"]);

      const typing = await getTypingAgents("chan_123");

      expect(typing).toHaveLength(2);
      expect(typing[0].agentId).toBe("agent1");
      expect(typing[1].agentId).toBe("agent2");
    });

    it("should clean up expired entries", async () => {
      mockDbClient.zrangebyscore.mockResolvedValueOnce([]);

      await getTypingAgents("chan_123");

      expect(mockDbClient.zremrangebyscore).toHaveBeenCalled();
    });
  });

  describe("getTypingState", () => {
    it("should return full typing state for channel", async () => {
      mockDbClient.zrangebyscore.mockResolvedValueOnce(["agent1"]);

      const state = await getTypingState("chan_123");

      expect(state.channelId).toBe("chan_123");
      expect(state.typing).toHaveLength(1);
      expect(state.timestamp).toBeGreaterThan(0);
    });
  });

  describe("isTyping", () => {
    it("should return true if agent is typing", async () => {
      mockDbClient.zrangebyscore.mockResolvedValueOnce(["agent1"]);

      const result = await isTyping("agent1", "chan_123");

      expect(result).toBe(true);
    });

    it("should return false if agent is not typing", async () => {
      mockDbClient.zrangebyscore.mockResolvedValueOnce(["agent2"]);

      const result = await isTyping("agent1", "chan_123");

      expect(result).toBe(false);
    });
  });

  describe("formatTypingText", () => {
    const agentNames = new Map([
      ["agent1", "Agent A"],
      ["agent2", "Agent B"],
      ["agent3", "Agent C"],
      ["agent4", "Agent D"],
      ["agent5", "Agent E"],
    ]);

    it("should format single agent typing", () => {
      const text = formatTypingText(
        [{ agentId: "agent1", channelId: "chan", startedAt: 0 }],
        agentNames,
      );
      expect(text).toBe("Agent A is typing...");
    });

    it("should format two agents typing", () => {
      const text = formatTypingText(
        [
          { agentId: "agent1", channelId: "chan", startedAt: 0 },
          { agentId: "agent2", channelId: "chan", startedAt: 0 },
        ],
        agentNames,
      );
      expect(text).toBe("Agent A and Agent B are typing...");
    });

    it("should format three agents typing", () => {
      const text = formatTypingText(
        [
          { agentId: "agent1", channelId: "chan", startedAt: 0 },
          { agentId: "agent2", channelId: "chan", startedAt: 0 },
          { agentId: "agent3", channelId: "chan", startedAt: 0 },
        ],
        agentNames,
      );
      expect(text).toBe("Agent A, Agent B, and Agent C are typing...");
    });

    it("should format many agents typing with 'N more'", () => {
      const text = formatTypingText(
        [
          { agentId: "agent1", channelId: "chan", startedAt: 0 },
          { agentId: "agent2", channelId: "chan", startedAt: 0 },
          { agentId: "agent3", channelId: "chan", startedAt: 0 },
          { agentId: "agent4", channelId: "chan", startedAt: 0 },
        ],
        agentNames,
      );
      expect(text).toContain("more are typing...");
    });

    it("should return empty for no agents", () => {
      const text = formatTypingText([], agentNames);
      expect(text).toBe("");
    });
  });

  describe("onMessageSent", () => {
    it("should stop typing when agent sends a message", async () => {
      await onMessageSent("agent1", "chan_123");

      expect(mockDbClient.zrem).toHaveBeenCalledWith("typing:chan_123", "agent1");
    });
  });

  describe("refreshTyping", () => {
    it("should re-add agent to typing set (extend TTL)", async () => {
      await refreshTyping("agent1", "chan_123");

      expect(mockDbClient.zadd).toHaveBeenCalledWith(
        "typing:chan_123",
        expect.any(Number),
        "agent1",
      );
    });
  });

  describe("subscribeToTyping", () => {
    it("should subscribe to Redis pub/sub", async () => {
      mockDbClient.subscribe.mockResolvedValueOnce(undefined);

      const unsubscribe = await subscribeToTyping("chan_123", () => {});

      expect(mockDbClient.subscribe).toHaveBeenCalledWith(
        "pubsub:channel:chan_123",
        expect.any(Function),
      );
      expect(typeof unsubscribe).toBe("function");
    });
  });
});
