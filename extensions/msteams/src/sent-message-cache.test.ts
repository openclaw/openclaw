// Msteams tests cover sent message cache plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "./runtime.js";
import {
  clearMSTeamsSentMessageCache,
  recordMSTeamsSentMessage,
  wasMSTeamsMessageSentWithPersistence,
} from "./sent-message-cache.js";

const TTL_MS = 24 * 60 * 60 * 1000;

describe("msteams sent message cache", () => {
  afterEach(() => {
    clearMSTeamsSentMessageCache();
    vi.restoreAllMocks();
  });

  it("records and resolves sent message ids", async () => {
    recordMSTeamsSentMessage("conv-1", "msg-1");
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-1" }),
    ).resolves.toBe(true);
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-2" }),
    ).resolves.toBe(false);
  });

  it("persists sent message ids when runtime state is available", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234_567);
    const register = vi.fn().mockResolvedValue(undefined);
    const lookup = vi.fn().mockResolvedValue({ sentAt: Date.now() });
    const openKeyedStore = vi.fn(() => ({
      register,
      lookup,
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setMSTeamsRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    recordMSTeamsSentMessage("conv-1", "msg-2");

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith("conv-1:msg-2", { sentAt: 1_234_567 });

    clearMSTeamsSentMessageCache();
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-2" }),
    ).resolves.toBe(true);
    expect(openKeyedStore).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith("conv-1:msg-2");

    lookup.mockClear();
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-2" }),
    ).resolves.toBe(true);
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-2" }),
    ).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("preserves the original TTL when recovering sent-message ids from persistent state", async () => {
    const sentAt = 1_000_000;
    const lookup = vi.fn(async () => (Date.now() - sentAt < TTL_MS ? { sentAt } : undefined));
    const openKeyedStore = vi.fn(() => ({
      register: vi.fn(),
      lookup,
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setMSTeamsRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    vi.spyOn(Date, "now").mockReturnValue(sentAt + TTL_MS - 1);
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-4" }),
    ).resolves.toBe(true);
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-4" }),
    ).resolves.toBe(true);

    lookup.mockClear();
    vi.mocked(Date.now).mockReturnValue(sentAt + TTL_MS + 1);

    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-4" }),
    ).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledWith("conv-1:msg-4");
  });

  it("falls back to in-memory sent-message markers when persistent state cannot open", async () => {
    const warn = vi.fn();
    setMSTeamsRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          throw new Error("sqlite unavailable");
        }),
      },
      logging: { getChildLogger: () => ({ warn }) },
    } as never);

    recordMSTeamsSentMessage("conv-1", "msg-3");

    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-3" }),
    ).resolves.toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("scopes sent-message markers by account", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234_567);
    const register = vi.fn().mockResolvedValue(undefined);
    const lookup = vi.fn().mockResolvedValue(undefined);
    const openKeyedStore = vi.fn(() => ({
      register,
      lookup,
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setMSTeamsRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    recordMSTeamsSentMessage("conv-1", "msg-1", { accountId: "support" });

    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conv-1",
        messageId: "msg-1",
        accountId: "support",
      }),
    ).resolves.toBe(true);
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conv-1",
        messageId: "msg-1",
        accountId: "finance",
      }),
    ).resolves.toBe(false);
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    const supportKey = register.mock.calls[0]?.[0];
    expect(supportKey).toMatch(/^account:v1:[a-f0-9]{64}$/);
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conv-1",
        messageId: "msg-1",
        accountId: "finance",
      }),
    ).resolves.toBe(false);
    const financeKey = lookup.mock.calls[0]?.[0];
    expect(financeKey).toMatch(/^account:v1:[a-f0-9]{64}$/);
    expect(financeKey).not.toBe(supportKey);
  });

  it("prevents named-account keys from colliding with legacy default keys", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const openKeyedStore = vi.fn(() => ({
      register,
      lookup: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setMSTeamsRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    recordMSTeamsSentMessage("19:conversation", "message");
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conversation",
        messageId: "message",
        accountId: "19",
      }),
    ).resolves.toBe(false);
    recordMSTeamsSentMessage("conversation", "message", { accountId: "19" });

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    const defaultKey = register.mock.calls[0]?.[0];
    const namedKey = register.mock.calls[1]?.[0];
    expect(defaultKey).toBe("19:conversation:message");
    expect(namedKey).toMatch(/^account:v1:[a-f0-9]{64}$/);
    expect(namedKey).not.toBe(defaultKey);
  });
});
