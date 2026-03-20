import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGroupName } from "./bot.js";

/**
 * Unit tests for resolveGroupName() in bot.ts.
 *
 * Covers: successful lookup, API failure, empty name, cache reuse,
 *         negative caching, undefined response, and cross-account isolation.
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
function makeAccount(id = "test-account") {
  return { accountId: id, appId: "cli_test", appSecret: "secret" } as any;
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
    const name1 = await resolveGroupName({ account, chatId: "oc_test_chat_004", log });
    expect(name1).toBe("Cached Group");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);

    const name2 = await resolveGroupName({ account, chatId: "oc_test_chat_004", log });
    expect(name2).toBe("Cached Group");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1); // no additional API call
  });

  it("caches negative result and skips API on retry", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("fail"));
    const name1 = await resolveGroupName({ account, chatId: "oc_test_chat_005", log });
    expect(name1).toBeUndefined();
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);

    const name2 = await resolveGroupName({ account, chatId: "oc_test_chat_005", log });
    expect(name2).toBeUndefined();
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1); // negative cache hit
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

  it("isolates cache entries across different accounts", async () => {
    const accountA = makeAccount("account-a");
    const accountB = makeAccount("account-b");

    // Account A fails → negative cache
    mockGetChatInfo.mockRejectedValueOnce(new Error("no permission"));
    const nameA = await resolveGroupName({
      account: accountA,
      chatId: "oc_shared_group",
      log,
    });
    expect(nameA).toBeUndefined();

    // Account B succeeds for the SAME chatId → should NOT be blocked by A's cache
    mockGetChatInfo.mockResolvedValueOnce({ name: "Shared Group" });
    const nameB = await resolveGroupName({
      account: accountB,
      chatId: "oc_shared_group",
      log,
    });
    expect(nameB).toBe("Shared Group");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(2); // both accounts hit API
  });
});
