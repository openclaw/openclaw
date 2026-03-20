import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGroupName } from "./bot.js";

/**
 * Unit tests for resolveGroupName() — the group-name resolution helper
 * added to support human-readable session labels for Feishu group chats.
 *
 * Covers: successful lookup, API failure, empty name, positive cache,
 *         negative cache, undefined response, and cross-account isolation.
 */

const mockGetChatInfo = vi.hoisted(() => vi.fn());
const mockCreateFeishuClient = vi.hoisted(() => vi.fn());

vi.mock("./chat.js", () => ({
  getChatInfo: mockGetChatInfo,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

function makeAccount(id = "test-account") {
  return { accountId: id, appId: "cli_test", appSecret: "secret" } as any;
}

describe("resolveGroupName", () => {
  const account = makeAccount();
  const log = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChatInfo.mockReset();
    mockCreateFeishuClient.mockReset();
    mockCreateFeishuClient.mockReturnValue({});
  });

  it("returns the group name on a successful API call", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "Engineering Team" });
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_001",
      log,
    });
    expect(name).toBe("Engineering Team");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
  });

  it("returns undefined and logs on API failure", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("network error"));
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_002",
      log,
    });
    expect(name).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("getChatInfo failed"),
    );
  });

  it("returns undefined when API returns whitespace-only name", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "   " });
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_003",
      log,
    });
    expect(name).toBeUndefined();
  });

  it("reuses cached result without additional API call", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "Cached Group" });

    const first = await resolveGroupName({ account, chatId: "oc_test_004", log });
    expect(first).toBe("Cached Group");

    const second = await resolveGroupName({ account, chatId: "oc_test_004", log });
    expect(second).toBe("Cached Group");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
  });

  it("caches negative result and skips API on subsequent calls", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("timeout"));

    await resolveGroupName({ account, chatId: "oc_test_005", log });
    const second = await resolveGroupName({ account, chatId: "oc_test_005", log });

    expect(second).toBeUndefined();
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when chatInfo is undefined", async () => {
    mockGetChatInfo.mockResolvedValue(undefined);
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_006",
      log,
    });
    expect(name).toBeUndefined();
  });

  it("isolates cache entries across different accounts", async () => {
    const accountA = makeAccount("account-a");
    const accountB = makeAccount("account-b");

    mockGetChatInfo.mockRejectedValueOnce(new Error("no permission"));
    const nameA = await resolveGroupName({
      account: accountA,
      chatId: "oc_shared_group",
      log,
    });
    expect(nameA).toBeUndefined();

    mockGetChatInfo.mockResolvedValueOnce({ name: "Shared Group" });
    const nameB = await resolveGroupName({
      account: accountB,
      chatId: "oc_shared_group",
      log,
    });
    expect(nameB).toBe("Shared Group");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(2);
  });
});
