import { describe, expect, it, vi } from "vitest";
import { createMatrixRoomMessageHandler } from "./handler.js";

function buildMinimalParams(overrides: Record<string, unknown> = {}) {
  const logVerboseMessage = vi.fn();
  const defaults = {
    client: { getUserId: vi.fn().mockResolvedValue("@bot:server") },
    core: {
      channel: {
        text: { resolveTextChunkLimit: () => 4000 },
        mentions: { buildMentionRegexes: () => [] },
        inbound: { handleInbound: vi.fn().mockResolvedValue(undefined) },
      },
    },
    cfg: {},
    runtime: {},
    logger: { info: vi.fn(), error: vi.fn() },
    logVerboseMessage,
    allowFrom: [],
    roomsConfig: undefined,
    mentionRegexes: [],
    groupPolicy: "open" as const,
    replyToMode: "off" as const,
    threadReplies: "off" as const,
    dmEnabled: true,
    dmPolicy: "open" as const,
    textLimit: 4000,
    mediaMaxBytes: 10 * 1024 * 1024,
    startupMs: 1000000,
    startupGraceMs: 30_000,
    directTracker: { isDirectMessage: vi.fn().mockResolvedValue(false) },
    getRoomInfo: vi.fn().mockResolvedValue({ name: "test-room", altAliases: [] }),
    getMemberDisplayName: vi.fn().mockResolvedValue("TestUser"),
    accountId: "default",
    ...overrides,
  };
  return {
    params: defaults as Parameters<typeof createMatrixRoomMessageHandler>[0],
    logVerboseMessage,
  };
}

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "m.room.message",
    sender: "@user:server",
    event_id: "$test-event",
    origin_server_ts: 999_000,
    content: { msgtype: "m.text", body: "hello" },
    unsigned: {},
    ...overrides,
  };
}

describe("createMatrixRoomMessageHandler", () => {
  describe("startup grace period", () => {
    it("drops messages with timestamp before startup minus grace period", async () => {
      const { params, logVerboseMessage } = buildMinimalParams({
        startupMs: 1_000_000,
        startupGraceMs: 30_000,
      });
      const handler = createMatrixRoomMessageHandler(params);
      // Event timestamp is 60s before startup — well outside the 30s grace
      const event = buildEvent({ origin_server_ts: 940_000 });

      await handler("!room:server", event);

      expect(logVerboseMessage).toHaveBeenCalledWith(expect.stringContaining("dropping message"));
    });

    it("accepts messages within the grace period", async () => {
      const inbound = vi.fn().mockResolvedValue(undefined);
      const { params } = buildMinimalParams({
        startupMs: 1_000_000,
        startupGraceMs: 30_000,
        core: {
          channel: {
            text: { resolveTextChunkLimit: () => 4000 },
            mentions: { buildMentionRegexes: () => [] },
            inbound: { handleInbound: inbound },
          },
        },
      });
      const handler = createMatrixRoomMessageHandler(params);
      // Event timestamp is 10s before startup — within 30s grace
      const event = buildEvent({ origin_server_ts: 990_000 });

      await handler("!room:server", event);

      // Should NOT have been dropped (no "dropping message" log)
      // The message proceeds past the timestamp check
    });

    it("drops messages by age when timestamp is missing", async () => {
      const { params, logVerboseMessage } = buildMinimalParams({
        startupMs: 1_000_000,
        startupGraceMs: 30_000,
      });
      const handler = createMatrixRoomMessageHandler(params);
      const event = buildEvent({
        origin_server_ts: undefined,
        unsigned: { age: 60_000 },
      });

      await handler("!room:server", event);

      expect(logVerboseMessage).toHaveBeenCalledWith(
        expect.stringContaining("age 60000ms exceeds graceMs=30000"),
      );
    });

    it("zero grace drops messages with any clock skew", async () => {
      const { params, logVerboseMessage } = buildMinimalParams({
        startupMs: 1_000_000,
        startupGraceMs: 0,
      });
      const handler = createMatrixRoomMessageHandler(params);
      // Event is just 1ms before startup
      const event = buildEvent({ origin_server_ts: 999_999 });

      await handler("!room:server", event);

      expect(logVerboseMessage).toHaveBeenCalledWith(expect.stringContaining("dropping message"));
    });
  });
});
