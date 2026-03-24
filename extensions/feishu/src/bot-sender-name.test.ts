import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFeishuSenderNameCachesForTests,
  resolveFeishuDirectNameFromChatMember,
  resolveFeishuSenderName,
} from "./bot-sender-name.js";

const mockCreateFeishuClient = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

function createAccount(accountId: string) {
  return {
    accountId,
    configured: true,
    enabled: true,
    selectionSource: "explicit",
    domain: "feishu",
    config: {},
  } as any;
}

describe("bot-sender-name cache scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFeishuSenderNameCachesForTests();
  });

  it("scopes sender name cache by account id", async () => {
    const getUser = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, data: { user: { name: "Account A Sender" } } })
      .mockResolvedValueOnce({ code: 0, data: { user: { name: "Account B Sender" } } });
    mockCreateFeishuClient.mockReturnValue({
      contact: { user: { get: getUser } },
    });

    await expect(
      resolveFeishuSenderName({
        account: createAccount("account-A"),
        senderId: "ou-shared-sender",
        log: vi.fn(),
      }),
    ).resolves.toEqual({ name: "Account A Sender" });

    await expect(
      resolveFeishuSenderName({
        account: createAccount("account-B"),
        senderId: "ou-shared-sender",
        log: vi.fn(),
      }),
    ).resolves.toEqual({ name: "Account B Sender" });

    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("scopes direct member display cache by account id", async () => {
    const getMembers = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [{ member_id: "ou-shared-direct", name: "Direct A" }] },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [{ member_id: "ou-shared-direct", name: "Direct B" }] },
      });
    mockCreateFeishuClient.mockReturnValue({
      im: { chatMembers: { get: getMembers } },
    });

    await expect(
      resolveFeishuDirectNameFromChatMember({
        account: createAccount("account-A"),
        chatId: "oc-dm-a",
        senderOpenId: "ou-shared-direct",
        log: vi.fn(),
      }),
    ).resolves.toBe("Direct A");

    await expect(
      resolveFeishuDirectNameFromChatMember({
        account: createAccount("account-B"),
        chatId: "oc-dm-b",
        senderOpenId: "ou-shared-direct",
        log: vi.fn(),
      }),
    ).resolves.toBe("Direct B");

    expect(getMembers).toHaveBeenCalledTimes(2);
  });
  it("uses a separate direct-member cache from sender profile lookups", async () => {
    const getUser = vi.fn().mockResolvedValue({
      code: 0,
      data: { user: { name: "Profile Sender" } },
    });
    const getMembers = vi.fn().mockResolvedValue({
      code: 0,
      data: { items: [{ member_id: "ou-direct-cache-split", name: "Direct Member" }] },
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: { user: { get: getUser } },
      im: { chatMembers: { get: getMembers } },
    });

    await expect(
      resolveFeishuSenderName({
        account: createAccount("account-cache-split"),
        senderId: "ou-direct-cache-split",
        log: vi.fn(),
      }),
    ).resolves.toEqual({ name: "Profile Sender" });

    await expect(
      resolveFeishuDirectNameFromChatMember({
        account: createAccount("account-cache-split"),
        chatId: "oc-dm-cache-split",
        senderOpenId: "ou-direct-cache-split",
        log: vi.fn(),
      }),
    ).resolves.toBe("Direct Member");

    expect(getMembers).toHaveBeenCalledTimes(1);
  });

  it("uses the sender id type for direct member lookups when open_id is unavailable", async () => {
    const getMembers = vi.fn().mockResolvedValue({
      code: 0,
      data: { items: [{ member_id: "fouser_direct_lookup", name: "Direct By UserId" }] },
    });
    mockCreateFeishuClient.mockReturnValue({
      im: { chatMembers: { get: getMembers } },
    });

    await expect(
      resolveFeishuDirectNameFromChatMember({
        account: createAccount("account-user-id"),
        chatId: "oc-dm-user-id",
        senderOpenId: "fouser_direct_lookup",
        log: vi.fn(),
      }),
    ).resolves.toBe("Direct By UserId");

    expect(getMembers).toHaveBeenCalledWith({
      path: { chat_id: "oc-dm-user-id" },
      params: { member_id_type: "user_id", page_size: 50 },
    });
  });

  it("negative-caches failed direct member lookups for a TTL window", async () => {
    const getMembers = vi.fn().mockResolvedValue({
      code: 999,
      msg: "missing scope",
    });
    mockCreateFeishuClient.mockReturnValue({
      im: { chatMembers: { get: getMembers } },
    });

    const params = {
      account: createAccount("account-negative-cache"),
      chatId: "oc-dm-negative-cache",
      senderOpenId: "ou-direct-negative-cache",
      log: vi.fn(),
    };

    await expect(resolveFeishuDirectNameFromChatMember(params)).resolves.toBeUndefined();
    await expect(resolveFeishuDirectNameFromChatMember(params)).resolves.toBeUndefined();

    expect(getMembers).toHaveBeenCalledTimes(1);
  });
});
