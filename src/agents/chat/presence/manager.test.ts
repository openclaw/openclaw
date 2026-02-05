import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  updatePresence,
  getPresence,
  getChannelPresence,
  heartbeat,
  setOffline,
  getOnlineAgents,
  isOnline,
  getPresenceSnapshot,
  cleanupStalePresence,
  subscribeToPresence,
} from "./manager.js";

// Mock the db client module
const mockDbClient = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  zadd: vi.fn(),
  zrem: vi.fn(),
  zrangebyscore: vi.fn(),
  zremrangebyscore: vi.fn(),
  expire: vi.fn(),
  hset: vi.fn(),
  hget: vi.fn(),
  hgetall: vi.fn(),
  hdel: vi.fn(),
  sadd: vi.fn(),
  smembers: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn().mockReturnValue(true),
};

vi.mock("../db/client.js", () => ({
  getChatDbClient: () => mockDbClient,
  REDIS_KEYS: {
    presence: (agentId: string, channelId: string) => `presence:${channelId}:${agentId}`,
    presenceChannel: (channelId: string) => `presence:${channelId}:*`,
    typing: (channelId: string) => `typing:${channelId}`,
    pubsubChannel: (channelId: string) => `pubsub:channel:${channelId}`,
  },
  REDIS_TTL: {
    presence: 300,
    typing: 10,
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

describe("presence manager", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default mocks for set/publish/execute
    mockDbClient.set.mockResolvedValue(undefined);
    mockDbClient.publish.mockResolvedValue(1);
    mockDbClient.execute.mockResolvedValue({ rowCount: 0 });
    mockDbClient.isConnected.mockReturnValue(true);
  });

  describe("updatePresence", () => {
    it("should update presence in Redis and return the presence object", async () => {
      const result = await updatePresence({
        agentId: "up_agent1",
        channelId: "up_chan_1",
        status: "active",
      });

      expect(result.agentId).toBe("up_agent1");
      expect(result.channelId).toBe("up_chan_1");
      expect(result.status).toBe("active");
      expect(result.lastSeenAt).toBeGreaterThan(0);
      expect(mockDbClient.set).toHaveBeenCalledWith(
        "presence:up_chan_1:up_agent1",
        expect.any(String),
        300,
      );
    });

    it("should publish a presence update event", async () => {
      await updatePresence({
        agentId: "up_agent2",
        channelId: "up_chan_2",
        status: "busy",
      });

      expect(mockDbClient.publish).toHaveBeenCalledWith(
        "pubsub:channel:up_chan_2",
        expect.stringContaining("presence.update"),
      );
    });

    it("should set custom status", async () => {
      const result = await updatePresence({
        agentId: "up_agent3",
        channelId: "up_chan_3",
        status: "busy",
        customStatus: "Working on code review",
      });

      expect(result.customStatus).toBe("Working on code review");
    });
  });

  describe("getPresence", () => {
    it("should return presence from Redis when available", async () => {
      // Use unique IDs to avoid cache from updatePresence tests
      mockDbClient.get.mockResolvedValueOnce(
        JSON.stringify({
          agentId: "gp_agent1",
          channelId: "gp_chan_1",
          status: "active",
          lastSeenAt: Date.now(),
        }),
      );

      const presence = await getPresence("gp_agent1", "gp_chan_1");

      expect(presence).toBeDefined();
      expect(presence?.status).toBe("active");
    });

    it("should fall back to PostgreSQL when not in Redis", async () => {
      mockDbClient.get.mockResolvedValueOnce(null);
      mockDbClient.queryOne.mockResolvedValueOnce({
        agent_id: "gp_agent2",
        channel_id: "gp_chan_2",
        status: "active",
        last_seen_at: new Date(),
        typing_started_at: null,
        custom_status: null,
      });

      const presence = await getPresence("gp_agent2", "gp_chan_2");

      expect(presence?.status).toBe("active");
      expect(mockDbClient.queryOne).toHaveBeenCalled();
    });

    it("should return null for non-existent presence", async () => {
      mockDbClient.get.mockResolvedValueOnce(null);
      mockDbClient.queryOne.mockResolvedValueOnce(null);

      const presence = await getPresence("gp_unknown", "gp_chan_3");

      expect(presence).toBeNull();
    });
  });

  describe("getChannelPresence", () => {
    it("should return presence for all agents in channel", async () => {
      const now = new Date();
      mockDbClient.query.mockResolvedValueOnce([
        {
          agent_id: "cp_agent1",
          channel_id: "cp_chan",
          status: "active",
          last_seen_at: now,
          typing_started_at: null,
          custom_status: null,
        },
        {
          agent_id: "cp_agent2",
          channel_id: "cp_chan",
          status: "busy",
          last_seen_at: now,
          typing_started_at: null,
          custom_status: null,
        },
      ]);

      const presences = await getChannelPresence("cp_chan");

      expect(presences).toHaveLength(2);
    });
  });

  describe("setOffline", () => {
    it("should set agent status to offline in a specific channel", async () => {
      await setOffline("so_agent1", "so_chan_1");

      expect(mockDbClient.set).toHaveBeenCalledWith(
        "presence:so_chan_1:so_agent1",
        expect.stringContaining('"status":"offline"'),
        300,
      );
    });

    it("should set offline in all channels when no channel specified", async () => {
      mockDbClient.query.mockResolvedValueOnce([
        { channel_id: "so_chan_a" },
        { channel_id: "so_chan_b" },
      ]);

      await setOffline("so_agent2");

      expect(mockDbClient.set).toHaveBeenCalledTimes(2);
    });
  });

  describe("heartbeat", () => {
    it("should update lastSeenAt and keep current status", async () => {
      // No existing presence
      mockDbClient.get.mockResolvedValueOnce(null);
      mockDbClient.queryOne.mockResolvedValueOnce(null);

      await heartbeat("hb_agent1", "hb_chan_1");

      // Should call updatePresence with "active"
      expect(mockDbClient.set).toHaveBeenCalledWith(
        "presence:hb_chan_1:hb_agent1",
        expect.stringContaining('"status":"active"'),
        300,
      );
    });
  });

  describe("isOnline", () => {
    it("should return true for active presence", async () => {
      mockDbClient.get.mockResolvedValueOnce(
        JSON.stringify({
          agentId: "io_agent1",
          channelId: "io_chan_1",
          status: "active",
          lastSeenAt: Date.now(),
        }),
      );

      const online = await isOnline("io_agent1", "io_chan_1");
      expect(online).toBe(true);
    });

    it("should return false for offline presence", async () => {
      mockDbClient.get.mockResolvedValueOnce(
        JSON.stringify({
          agentId: "io_agent2",
          channelId: "io_chan_2",
          status: "offline",
          lastSeenAt: Date.now(),
        }),
      );

      const online = await isOnline("io_agent2", "io_chan_2");
      expect(online).toBe(false);
    });

    it("should return false when no presence exists", async () => {
      mockDbClient.get.mockResolvedValueOnce(null);
      mockDbClient.queryOne.mockResolvedValueOnce(null);

      const online = await isOnline("io_agent3", "io_chan_3");
      expect(online).toBe(false);
    });
  });

  describe("getOnlineAgents", () => {
    it("should return agents that are not offline", async () => {
      const now = new Date();
      mockDbClient.query.mockResolvedValueOnce([
        {
          agent_id: "oa_agent1",
          channel_id: "oa_chan",
          status: "active",
          last_seen_at: now,
          typing_started_at: null,
          custom_status: null,
        },
        {
          agent_id: "oa_agent2",
          channel_id: "oa_chan",
          status: "offline",
          last_seen_at: now,
          typing_started_at: null,
          custom_status: null,
        },
        {
          agent_id: "oa_agent3",
          channel_id: "oa_chan",
          status: "busy",
          last_seen_at: now,
          typing_started_at: null,
          custom_status: null,
        },
      ]);

      const online = await getOnlineAgents("oa_chan");

      expect(online).toContain("oa_agent1");
      expect(online).toContain("oa_agent3");
      expect(online).not.toContain("oa_agent2");
    });
  });

  describe("getPresenceSnapshot", () => {
    it("should return a snapshot with channel presence data", async () => {
      const now = new Date();
      mockDbClient.query.mockResolvedValueOnce([
        {
          agent_id: "ps_agent1",
          channel_id: "ps_chan",
          status: "active",
          last_seen_at: now,
          typing_started_at: null,
          custom_status: null,
        },
      ]);

      const snapshot = await getPresenceSnapshot("ps_chan");

      expect(snapshot.channelId).toBe("ps_chan");
      expect(snapshot.presence).toHaveLength(1);
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });
  });

  describe("cleanupStalePresence", () => {
    it("should mark stale entries as offline", async () => {
      mockDbClient.execute.mockResolvedValueOnce({ rowCount: 3 });

      const count = await cleanupStalePresence();

      expect(count).toBe(3);
      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE agent_presence"),
        expect.any(Array),
      );
    });
  });

  describe("subscribeToPresence", () => {
    it("should subscribe to Redis pub/sub channel", async () => {
      mockDbClient.subscribe.mockResolvedValueOnce(undefined);

      const unsubscribe = await subscribeToPresence("sp_chan", () => {});

      expect(mockDbClient.subscribe).toHaveBeenCalledWith(
        "pubsub:channel:sp_chan",
        expect.any(Function),
      );
      expect(typeof unsubscribe).toBe("function");
    });
  });
});
