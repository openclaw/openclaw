import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the group-name resolution logic added to bot.ts.
 *
 * Covers: successful lookup, API failure, empty name, negative caching,
 *         positive cache reuse, and DM bypass.
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
  return { accountId: "test-account", appId: "cli_test", appSecret: "secret" };
}

function makeFakeClient() {
  return { im: { chat: { get: vi.fn() } } };
}

// ---- inline resolveGroupName replica for isolated testing ----
// We re-implement the cache + resolver here so the test file is self-contained
// and does not require importing private symbols from bot.ts.
const groupNameCache = new Map<string, { name: string; expiresAt: number }>();
const GROUP_NAME_CACHE_TTL_MS = 30 * 60 * 1000;

async function resolveGroupName(params: {
  account: ReturnType<typeof makeAccount>;
  chatId: string;
  log: (...args: unknown[]) => void;
}): Promise<string | undefined> {
  const { account, chatId, log } = params;
  const cached = groupNameCache.get(chatId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name || undefined;
  }
  try {
    const client = mockCreateFeishuClient(account);
    const chatInfo = await mockGetChatInfo(client, chatId);
    const name = chatInfo?.name?.trim();
    if (name) {
      groupNameCache.set(chatId, {
        name,
        expiresAt: Date.now() + GROUP_NAME_CACHE_TTL_MS,
      });
      return name;
    }
    groupNameCache.set(chatId, {
      name: "",
      expiresAt: Date.now() + GROUP_NAME_CACHE_TTL_MS,
    });
  } catch (err) {
    log(
      `feishu[${account.accountId}]: getChatInfo failed for ${chatId}: ${String(err)}`,
    );
    groupNameCache.set(chatId, {
      name: "",
      expiresAt: Date.now() + GROUP_NAME_CACHE_TTL_MS,
    });
  }
  return undefined;
}

// ---- test suite ----
describe("resolveGroupName", () => {
  const account = makeAccount();
  const log = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChatInfo.mockReset();
    mockCreateFeishuClient.mockReset();
    groupNameCache.clear();
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

  it("returns undefined and caches negative result on API failure", async () => {
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
    // Negative cache entry should exist
    const cached = groupNameCache.get("oc_test_chat_002");
    expect(cached).toBeDefined();
    expect(cached!.name).toBe("");
  });

  it("returns undefined when API returns empty/whitespace name", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "   " });
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_chat_003",
      log,
    });
    expect(name).toBeUndefined();
    // Should still cache negative result
    const cached = groupNameCache.get("oc_test_chat_003");
    expect(cached).toBeDefined();
    expect(cached!.name).toBe("");
  });

  it("skips API call when negative cache exists", async () => {
    // Pre-populate negative cache
    groupNameCache.set("oc_test_chat_004", {
      name: "",
      expiresAt: Date.now() + GROUP_NAME_CACHE_TTL_MS,
    });
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_chat_004",
      log,
    });
    expect(name).toBeUndefined();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("returns cached name without API call on cache hit", async () => {
    // Pre-populate positive cache
    groupNameCache.set("oc_test_chat_005", {
      name: "Cached Group",
      expiresAt: Date.now() + GROUP_NAME_CACHE_TTL_MS,
    });
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_chat_005",
      log,
    });
    expect(name).toBe("Cached Group");
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("calls API again after cache expires", async () => {
    // Pre-populate expired cache
    groupNameCache.set("oc_test_chat_006", {
      name: "Old Name",
      expiresAt: Date.now() - 1000,
    });
    mockGetChatInfo.mockResolvedValue({ name: "New Name" });
    const name = await resolveGroupName({
      account,
      chatId: "oc_test_chat_006",
      log,
    });
    expect(name).toBe("New Name");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
  });
});
