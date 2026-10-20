// Feishu tests cover bot group name plugin behavior.
import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";
import { feishuGroupNameCache } from "./bot-group-name-state.js";
import { resolveGroupName } from "./bot-group-name.js";
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
    config: {
      domain: "feishu",
      connectionMode: "websocket",
      webhookPath: "/feishu/events",
      dmPolicy: "pairing",
      reactionNotifications: "own",
      groupPolicy: "allowlist",
      typingIndicator: true,
      resolveSenderNames: true,
    },
  };
}

describe("resolveGroupName", () => {
  const account = makeAccount();
  const log = vi.fn();

  afterAll(() => {
    vi.doUnmock("./chat.js");
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChatInfo.mockReset();
    mockCreateFeishuClient.mockReset();
    mockCreateFeishuClient.mockReturnValue({});
    feishuGroupNameCache.clear();
  });

  it("returns undefined for whitespace-only name", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "   " });
    const result = await resolveGroupName({ account, chatId: "oc_test3", log });
    expect(result).toBeUndefined();
  });

  it("caches negative result (API failure) and skips retry", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("fail"));
    await expect(resolveGroupName({ account, chatId: "oc_test5", log })).resolves.toBeUndefined();
    mockGetChatInfo.mockResolvedValue({ name: "Recovered" });
    const result = await resolveGroupName({ account, chatId: "oc_test5", log });
    expect(result).toBeUndefined(); // still cached negative
    expect(mockGetChatInfo).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "feishu[test-account]: getChatInfo failed for oc_test5: Error: fail",
    );
  });

  it("isolates cache entries across different accounts", async () => {
    const accountA = makeAccount("account-A");
    const accountB = makeAccount("account-B");
    mockGetChatInfo
      .mockResolvedValueOnce({ name: "Team Alpha" })
      .mockResolvedValueOnce({ name: "Team Beta" });

    const nameA = await resolveGroupName({ account: accountA, chatId: "oc_shared", log });
    const nameB = await resolveGroupName({ account: accountB, chatId: "oc_shared", log });

    expect(nameA).toBe("Team Alpha");
    expect(nameB).toBe("Team Beta");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(2); // separate API calls
  });
});
