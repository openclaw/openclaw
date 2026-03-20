import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGroupName } from "./bot.js";

/**
 * Unit tests for resolveGroupName() in bot.ts.
 *
 * Covers: successful lookup, API failure, empty name, negative caching,
 *         positive cache reuse, and cache expiration.
 */

// ---- hoisted mocks (following bot.test.ts pattern) ----
const mockGetChatInfo = vi.hoisted(() => vi.fn());
const mockCreateFeishuClient = vi.hoisted(() => vi.fn());

vi.mock("./chat.js", () => ({
  getChatInfo: mockGetChatInfo,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

// ---- helpers ----
function makeAccount() {
  return { accountId: "test-account", appId: "cli_test", appSecret: "secret" } as any;
}

function makeFakeClient() {
  return { im: { chat: { get: vi.fn() } } };
}

// ---- test suite ----
describe("resolveGroupName", () => {
  const account = makeAccount();
  const log = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChatInfo.mockReset();
    mockCreateFeishuClient.mockReset();
    mockCreateFeishuClient.mockReturnValue(makeFakeClient());
  });

  it("returns group name on successful API call", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "Engineering Team" });
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_chat_001",
      log,
    });
    expect(name).toBe("Engineering Team");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
  });

  it("returns undefined and logs on API failure", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("network error"));
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_chat_002",
      log,
    });
    expect(name).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("getChatInfo failed"),
    );
  });

  it("returns undefined when API returns empty/whitespace name", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "   " });
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_chat_003",
      log,
    });
    expect(name).toBeUndefined();
  });

  it("uses cached result on second call within TTL", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "Cached Group" });
    // First call — hits API
    const name1 = await resolveGroupName({ account, chatId: "oc_test_chat_004", log });
    expect(name1).toBe("Cached Group");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    const name2 = await resolveGroupName({ account, chatId: "oc_test_chat_004", log });
    expect(name2).toBe("Cached Group");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1); // no additional API call
  });

  it("caches negative result and returns undefined without re-calling API", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("fail"));
    // First call — fails and caches negative result
    const name1 = await resolveGroupName({ account, chatId: "oc_test_chat_005", log });
    expect(name1).toBeUndefined();
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);

    // Second call — should use negative cache
    const name2 = await resolveGroupName({ account, chatId: "oc_test_chat_005", log });
    expect(name2).toBeUndefined();
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1); // no additional API call
  });

  it("returns undefined for missing chatInfo response", async () => {
    mockGetChatInfo.mockResolvedValue(undefined);
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_chat_006",
      log,
    });
    expect(name).toBeUndefined();
  });
});
