import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { feishuGroupNameCache } from "./bot-group-name-state.js";
import { resolveGroupName } from "./bot-group-name.js";
import { FeishuConfigSchema } from "./config-schema.js";
import type { ResolvedFeishuAccount } from "./types.js";

const mockGetChatInfo = vi.hoisted(() => vi.fn());
const mockCreateFeishuClient = vi.hoisted(() => vi.fn());

vi.mock("./chat.js", () => ({ getChatInfo: mockGetChatInfo }));
vi.mock("./client.js", () => ({ createFeishuClient: mockCreateFeishuClient }));

function makeAccount(id = "test-account"): ResolvedFeishuAccount {
  return {
    accountId: id,
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret",
    domain: "feishu",
    config: FeishuConfigSchema.parse({}),
  };
}

describe("resolveGroupName", () => {
  const account = makeAccount();
  const log = vi.fn();
  const lookup = (chatId: string, selectedAccount = account) =>
    resolveGroupName({ account: selectedAccount, chatId, log });

  afterAll(() => {
    vi.doUnmock("./chat.js");
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChatInfo.mockReset();
    mockCreateFeishuClient.mockReset();
    mockCreateFeishuClient.mockReturnValue({});
    feishuGroupNameCache.clear();
  });

  it("returns undefined for whitespace-only name", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "   " });
    await expect(lookup("oc_test3")).resolves.toBeUndefined();
  });

  it("shares a cold lookup and blocks for a fresh name after expiry", async () => {
    vi.useFakeTimers();
    const first = createDeferred<{ name: string }>();
    mockGetChatInfo.mockReturnValue(first.promise);
    const initial = [lookup("oc_shared"), lookup("oc_shared")];
    first.resolve({ name: "Original name" });
    await expect(Promise.all(initial)).resolves.toEqual(["Original name", "Original name"]);
    expect(mockGetChatInfo).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(30 * 60_000);
    mockGetChatInfo.mockResolvedValueOnce({ name: "Updated name" });
    await expect(lookup("oc_shared")).resolves.toBe("Updated name");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(2);
  });

  it("caches negative result (API failure) and skips retry", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("fail"));
    await expect(lookup("oc_test5")).resolves.toBeUndefined();
    mockGetChatInfo.mockResolvedValue({ name: "Recovered" });
    await expect(lookup("oc_test5")).resolves.toBeUndefined();
    expect(mockGetChatInfo).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "feishu[test-account]: getChatInfo failed for oc_test5: Error: fail",
    );
  });

  it("isolates cache entries across different accounts", async () => {
    mockGetChatInfo
      .mockResolvedValueOnce({ name: "Team Alpha" })
      .mockResolvedValueOnce({ name: "Team Beta" });

    await expect(lookup("oc_shared", makeAccount("account-A"))).resolves.toBe("Team Alpha");
    await expect(lookup("oc_shared", makeAccount("account-B"))).resolves.toBe("Team Beta");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(2);
  });
});
