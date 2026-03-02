import { beforeEach, describe, expect, it, vi } from "vitest";
import { telegramUserbotStreamingAdapter, sendTypingIndicator } from "./streaming.js";

// Mocks for ConnectionManager + UserbotClient
const mockSetTyping = vi.fn(async () => {});
const mockClient = {
  isConnected: vi.fn().mockReturnValue(true),
  setTyping: mockSetTyping,
};
const mockManager = {
  getClient: vi.fn().mockReturnValue(mockClient),
};

vi.mock("../channel.js", () => ({
  getConnectionManager: vi.fn((accountId: string) => {
    if (accountId === "missing") return undefined;
    return mockManager;
  }),
}));

describe("telegramUserbotStreamingAdapter", () => {
  it("provides block streaming coalesce defaults", () => {
    expect(telegramUserbotStreamingAdapter.blockStreamingCoalesceDefaults).toEqual({
      minChars: 1500,
      idleMs: 1000,
    });
  });

  it("has the expected adapter shape", () => {
    expect(telegramUserbotStreamingAdapter).toHaveProperty("blockStreamingCoalesceDefaults");
    const defaults = telegramUserbotStreamingAdapter.blockStreamingCoalesceDefaults;
    expect(defaults).toBeDefined();
    expect(typeof defaults!.minChars).toBe("number");
    expect(typeof defaults!.idleMs).toBe("number");
  });
});

describe("sendTypingIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.isConnected.mockReturnValue(true);
  });

  it("sends typing via the active client", async () => {
    await sendTypingIndicator("default", "12345");
    expect(mockManager.getClient).toHaveBeenCalled();
    expect(mockSetTyping).toHaveBeenCalledWith("12345");
  });

  it("is a no-op when connection manager is absent", async () => {
    await sendTypingIndicator("missing", "12345");
    expect(mockSetTyping).not.toHaveBeenCalled();
  });

  it("is a no-op when client is disconnected", async () => {
    mockClient.isConnected.mockReturnValue(false);
    await sendTypingIndicator("default", "12345");
    expect(mockSetTyping).not.toHaveBeenCalled();
  });

  it("accepts numeric peer ids", async () => {
    await sendTypingIndicator("default", 67890);
    expect(mockSetTyping).toHaveBeenCalledWith(67890);
  });
});
