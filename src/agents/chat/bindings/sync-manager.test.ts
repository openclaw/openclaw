import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExternalPlatform, IPlatformAdapter } from "./types.js";
import {
  registerAdapter,
  getAdapter,
  createBinding,
  getBinding,
  getBindingsForChannel,
  getBindingsForExternal,
  deleteBinding,
  onBindingEvent,
} from "./sync-manager.js";

const mockDbClient = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
};

vi.mock("../db/client.js", () => ({
  getChatDbClient: () => mockDbClient,
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

vi.mock("../store/message-store.js", () => ({
  createMessage: vi.fn().mockResolvedValue({ id: "cmsg_new" }),
}));

describe("sync-manager", () => {
  const createMockAdapter = (platform = "slack"): IPlatformAdapter => ({
    platform: platform as ExternalPlatform,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    sendMessage: vi.fn().mockResolvedValue("ext_123"),
    getMessages: vi.fn().mockResolvedValue([]),
    onMessage: vi.fn(),
    onReaction: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbClient.execute.mockResolvedValue({ rowCount: 1 });
    mockDbClient.query.mockResolvedValue([]);
  });

  describe("registerAdapter and getAdapter", () => {
    it("should register and retrieve a platform adapter", () => {
      const adapter = createMockAdapter("discord");

      registerAdapter(adapter);
      const retrieved = getAdapter("discord" as ExternalPlatform);

      expect(retrieved).toBe(adapter);
    });
  });

  describe("createBinding", () => {
    it("should create a new channel binding", async () => {
      const binding = await createBinding({
        agentChannelId: "chan_456",
        platform: "slack" as ExternalPlatform,
        externalAccountId: "workspace_1",
        externalChannelId: "C123456",
      });

      expect(binding.bindingId).toMatch(/^bind_/);
      expect(binding.agentChannelId).toBe("chan_456");
      expect(binding.platform).toBe("slack");
      expect(binding.direction).toBe("bidirectional");
      expect(binding.status).toBe("active");
      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO external_bindings"),
        expect.any(Array),
      );
    });

    it("should use default sync options", async () => {
      const binding = await createBinding({
        agentChannelId: "chan_456",
        platform: "slack" as ExternalPlatform,
        externalAccountId: "workspace_1",
        externalChannelId: "C123456",
      });

      expect(binding.syncOptions.syncMessages).toBe(true);
      expect(binding.syncOptions.syncThreads).toBe(false);
    });

    it("should merge custom sync options", async () => {
      const binding = await createBinding({
        agentChannelId: "chan_456",
        platform: "slack" as ExternalPlatform,
        externalAccountId: "workspace_1",
        externalChannelId: "C123456",
        syncOptions: { syncThreads: true },
      });

      expect(binding.syncOptions.syncMessages).toBe(true); // default
      expect(binding.syncOptions.syncThreads).toBe(true); // overridden
    });
  });

  describe("getBinding", () => {
    it("should retrieve binding by ID", async () => {
      const now = new Date();
      mockDbClient.queryOne.mockResolvedValueOnce({
        binding_id: "bind_123",
        channel_id: "chan_456",
        platform: "slack",
        external_account_id: "workspace_1",
        external_target_id: "C123456",
        direction: "bidirectional",
        sync_options: '{"syncMessages":true}',
        created_at: now,
        enabled: true,
        last_sync_at: null,
        sync_cursor: null,
      });

      const binding = await getBinding("bind_123");

      expect(binding?.bindingId).toBe("bind_123");
      expect(binding?.platform).toBe("slack");
    });

    it("should return null for non-existent binding", async () => {
      mockDbClient.queryOne.mockResolvedValueOnce(null);

      const binding = await getBinding("nonexistent");

      expect(binding).toBeNull();
    });
  });

  describe("getBindingsForChannel", () => {
    it("should return bindings for an agent channel", async () => {
      const now = new Date();
      mockDbClient.query.mockResolvedValueOnce([
        {
          binding_id: "bind_1",
          channel_id: "chan_456",
          platform: "slack",
          external_account_id: "ws_1",
          external_target_id: "C1",
          direction: "bidirectional",
          sync_options: "{}",
          created_at: now,
          enabled: true,
          last_sync_at: null,
          sync_cursor: null,
        },
        {
          binding_id: "bind_2",
          channel_id: "chan_456",
          platform: "discord",
          external_account_id: "guild_1",
          external_target_id: "D1",
          direction: "inbound",
          sync_options: "{}",
          created_at: now,
          enabled: true,
          last_sync_at: null,
          sync_cursor: null,
        },
      ]);

      const bindings = await getBindingsForChannel("chan_456");

      expect(bindings).toHaveLength(2);
    });
  });

  describe("getBindingsForExternal", () => {
    it("should return bindings for an external channel", async () => {
      const now = new Date();
      mockDbClient.query.mockResolvedValueOnce([
        {
          binding_id: "bind_1",
          channel_id: "chan_456",
          platform: "slack",
          external_account_id: "ws_1",
          external_target_id: "C123",
          direction: "bidirectional",
          sync_options: "{}",
          created_at: now,
          enabled: true,
          last_sync_at: null,
          sync_cursor: null,
        },
      ]);

      const bindings = await getBindingsForExternal("slack" as ExternalPlatform, "C123");

      expect(bindings).toHaveLength(1);
      expect(bindings[0].externalChannelId).toBe("C123");
    });
  });

  describe("deleteBinding", () => {
    it("should delete a binding", async () => {
      await deleteBinding("bind_123");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM external_bindings"),
        ["bind_123"],
      );
    });
  });

  describe("onBindingEvent", () => {
    it("should register and unregister event listener", () => {
      const listener = vi.fn();
      const unsub = onBindingEvent(listener);

      expect(typeof unsub).toBe("function");
      unsub();
    });
  });
});
