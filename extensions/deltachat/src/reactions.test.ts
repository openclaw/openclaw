import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const loadReactions = async () => await import("./reactions.js");

// Mock accounts module
vi.mock("./accounts.js", () => ({
  resolveDeltaChatAccount: vi.fn().mockReturnValue({
    accountId: "default",
    name: "Test Account",
    enabled: true,
    configured: true,
    config: {
      reactionLevel: "minimal",
      actions: { reactions: true },
      dataDir: "/tmp/test",
    },
  }),
}));

// Mock rpc-server module
vi.mock("./rpc-server.js", () => ({
  rpcServerManager: {
    start: vi.fn().mockResolvedValue({
      rpc: {
        sendReaction: (...args: unknown[]) => rpcMock(...args),
        getMessageReactions: (...args: unknown[]) => rpcMock(...args),
        getAllAccounts: vi
          .fn()
          .mockResolvedValue([{ id: 1, kind: "Configured", addr: "test@example.com" }]),
      },
    }),
  },
}));

describe("resolveDeltaChatReactionLevel", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns off level with all features disabled", async () => {
    vi.doMock("./accounts.js", () => ({
      resolveDeltaChatAccount: () => ({
        accountId: "default",
        config: { reactionLevel: "off" },
      }),
    }));

    const { resolveDeltaChatReactionLevel } = await loadReactions();
    const result = resolveDeltaChatReactionLevel({
      cfg: { channels: { deltachat: {} } } as any,
    });

    expect(result.level).toBe("off");
    expect(result.ackEnabled).toBe(false);
    expect(result.agentReactionsEnabled).toBe(false);
  });

  it("returns ack level with only ack enabled", async () => {
    vi.doMock("./accounts.js", () => ({
      resolveDeltaChatAccount: () => ({
        accountId: "default",
        config: { reactionLevel: "ack" },
      }),
    }));

    const { resolveDeltaChatReactionLevel } = await loadReactions();
    const result = resolveDeltaChatReactionLevel({
      cfg: { channels: { deltachat: {} } } as any,
    });

    expect(result.level).toBe("ack");
    expect(result.ackEnabled).toBe(true);
    expect(result.agentReactionsEnabled).toBe(false);
  });

  it("returns minimal level with agent reactions enabled", async () => {
    vi.doMock("./accounts.js", () => ({
      resolveDeltaChatAccount: () => ({
        accountId: "default",
        config: { reactionLevel: "minimal" },
      }),
    }));

    const { resolveDeltaChatReactionLevel } = await loadReactions();
    const result = resolveDeltaChatReactionLevel({
      cfg: { channels: { deltachat: {} } } as any,
    });

    expect(result.level).toBe("minimal");
    expect(result.ackEnabled).toBe(false);
    expect(result.agentReactionsEnabled).toBe(true);
    expect(result.agentReactionGuidance).toBe("minimal");
  });

  it("returns extensive level with agent reactions enabled", async () => {
    vi.doMock("./accounts.js", () => ({
      resolveDeltaChatAccount: () => ({
        accountId: "default",
        config: { reactionLevel: "extensive" },
      }),
    }));

    const { resolveDeltaChatReactionLevel } = await loadReactions();
    const result = resolveDeltaChatReactionLevel({
      cfg: { channels: { deltachat: {} } } as any,
    });

    expect(result.level).toBe("extensive");
    expect(result.ackEnabled).toBe(false);
    expect(result.agentReactionsEnabled).toBe(true);
    expect(result.agentReactionGuidance).toBe("extensive");
  });

  it("defaults to minimal level when not specified", async () => {
    vi.doMock("./accounts.js", () => ({
      resolveDeltaChatAccount: () => ({
        accountId: "default",
        config: {}, // No reactionLevel specified
      }),
    }));

    const { resolveDeltaChatReactionLevel } = await loadReactions();
    const result = resolveDeltaChatReactionLevel({
      cfg: { channels: { deltachat: {} } } as any,
    });

    expect(result.level).toBe("minimal");
    expect(result.agentReactionsEnabled).toBe(true);
  });
});

describe("normalizeDeltaChatReactionParams", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("parses numeric chat ID and message ID", async () => {
    const { normalizeDeltaChatReactionParams } = await loadReactions();
    const result = normalizeDeltaChatReactionParams({
      target: "123",
      messageId: "456",
      emoji: "👍",
    });

    expect(result.chatId).toBe(123);
    expect(result.messageId).toBe(456);
    expect(result.emoji).toBe("👍");
    expect(result.remove).toBe(false);
  });

  it("throws error for non-numeric chat ID", async () => {
    const { normalizeDeltaChatReactionParams } = await loadReactions();
    expect(() =>
      normalizeDeltaChatReactionParams({
        target: "email@example.com",
        messageId: "456",
        emoji: "👍",
      }),
    ).toThrow("Chat ID must be numeric");
  });

  it("throws error for missing message ID", async () => {
    const { normalizeDeltaChatReactionParams } = await loadReactions();
    expect(() =>
      normalizeDeltaChatReactionParams({
        target: "123",
        messageId: "",
        emoji: "👍",
      }),
    ).toThrow("Message ID is required");
  });

  it("throws error for missing emoji when adding", async () => {
    const { normalizeDeltaChatReactionParams } = await loadReactions();
    expect(() =>
      normalizeDeltaChatReactionParams({
        target: "123",
        messageId: "456",
        emoji: "",
      }),
    ).toThrow("Emoji is required when adding");
  });

  it("allows missing emoji when removing", async () => {
    const { normalizeDeltaChatReactionParams } = await loadReactions();
    const result = normalizeDeltaChatReactionParams({
      target: "123",
      messageId: "456",
      remove: true,
    });

    expect(result.chatId).toBe(123);
    expect(result.messageId).toBe(456);
    expect(result.emoji).toBeUndefined();
    expect(result.remove).toBe(true);
  });
});

describe("sendReactionDeltaChat", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("sends reaction with valid parameters", async () => {
    rpcMock.mockResolvedValue(undefined);

    const { sendReactionDeltaChat } = await loadReactions();
    const result = await sendReactionDeltaChat(123, 456, "👍", { accountId: "default" });

    expect(result.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      1, // account ID from mock
      456,
      ["👍"],
    );
  });

  it("returns error for invalid chat ID", async () => {
    const { sendReactionDeltaChat } = await loadReactions();
    const result = await sendReactionDeltaChat(0, 456, "👍");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Valid chat ID is required");
  });

  it("returns error for invalid message ID", async () => {
    const { sendReactionDeltaChat } = await loadReactions();
    const result = await sendReactionDeltaChat(123, 0, "👍");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Valid message ID is required");
  });

  it("returns error for missing emoji", async () => {
    const { sendReactionDeltaChat } = await loadReactions();
    const result = await sendReactionDeltaChat(123, 456, "");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Emoji is required");
  });

  it("handles RPC errors gracefully", async () => {
    rpcMock.mockRejectedValue(new Error("RPC error"));

    const { sendReactionDeltaChat } = await loadReactions();
    const result = await sendReactionDeltaChat(123, 456, "👍", { accountId: "default" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to send reaction");
  });
});

describe("removeReactionDeltaChat", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("removes all reactions when no emoji specified", async () => {
    rpcMock.mockResolvedValue(undefined);

    const { removeReactionDeltaChat } = await loadReactions();
    const result = await removeReactionDeltaChat(123, 456, undefined, { accountId: "default" });

    expect(result.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      1, // account ID from mock
      456,
      [],
    );
  });

  it("removes specific reaction when emoji specified", async () => {
    rpcMock
      .mockResolvedValueOnce({
        reactions: [
          { emoji: "👍", count: 1 },
          { emoji: "❤️", count: 1 },
        ],
      })
      .mockResolvedValueOnce(undefined);

    const { removeReactionDeltaChat } = await loadReactions();
    const result = await removeReactionDeltaChat(123, 456, "👍", { accountId: "default" });

    expect(result.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock).toHaveBeenNthCalledWith(1, 1, 456);
    expect(rpcMock).toHaveBeenNthCalledWith(2, 1, 456, ["❤️"]);
  });

  it("handles null reaction result gracefully", async () => {
    rpcMock.mockResolvedValueOnce(null);

    const { removeReactionDeltaChat } = await loadReactions();
    const result = await removeReactionDeltaChat(123, 456, "👍", { accountId: "default" });

    expect(result.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});

describe("getReactionsDeltaChat", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns empty array when no reactions", async () => {
    rpcMock.mockResolvedValue(null);

    const { getReactionsDeltaChat } = await loadReactions();
    const result = await getReactionsDeltaChat(123, 456, { accountId: "default" });

    expect(result).toEqual([]);
  });

  it("returns emoji strings from reaction result", async () => {
    rpcMock.mockResolvedValue({
      reactions: [
        { emoji: "👍", count: 2 },
        { emoji: "❤️", count: 1 },
      ],
    });

    const { getReactionsDeltaChat } = await loadReactions();
    const result = await getReactionsDeltaChat(123, 456, { accountId: "default" });

    expect(result).toEqual(["👍", "❤️"]);
  });

  it("throws error for invalid chat ID", async () => {
    const { getReactionsDeltaChat } = await loadReactions();
    await expect(getReactionsDeltaChat(0, 456)).rejects.toThrow("Valid chat ID is required");
  });

  it("throws error for invalid message ID", async () => {
    const { getReactionsDeltaChat } = await loadReactions();
    await expect(getReactionsDeltaChat(123, 0)).rejects.toThrow("Valid message ID is required");
  });

  it("handles RPC errors gracefully", async () => {
    rpcMock.mockRejectedValue(new Error("RPC error"));

    const { getReactionsDeltaChat } = await loadReactions();
    await expect(getReactionsDeltaChat(123, 456, { accountId: "default" })).rejects.toThrow(
      "Failed to get reactions",
    );
  });
});
