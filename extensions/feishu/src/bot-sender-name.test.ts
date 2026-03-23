import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
});
