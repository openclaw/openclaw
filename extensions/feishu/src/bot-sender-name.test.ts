import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearFeishuSenderNameCache, resolveFeishuSenderName } from "./bot-sender-name.js";
import type { ResolvedFeishuAccount } from "./types.js";

const mockCreateFeishuClient = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({ createFeishuClient: mockCreateFeishuClient }));

function makeAccount(accountId: string): ResolvedFeishuAccount {
  return {
    accountId,
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: `cli_${accountId}`,
    appSecret: "secret",
    domain: "feishu",
    config: {
      domain: "feishu",
      connectionMode: "websocket",
      webhookPath: "/feishu/events",
      dmPolicy: "open",
      reactionNotifications: "own",
      groupPolicy: "allowlist",
      typingIndicator: true,
      resolveSenderNames: true,
    },
  };
}

function mockClient(params: {
  memberName?: string;
  memberId?: string;
  memberError?: unknown;
  contactName?: string;
  contactError?: unknown;
}) {
  const chatMembersGet = vi.fn(async () => {
    if (params.memberError) {
      throw params.memberError;
    }
    return {
      code: 0,
      data: {
        items: params.memberName
          ? [
              {
                member_id: params.memberId ?? "ou_sender",
                member_id_type: "open_id",
                name: params.memberName,
              },
            ]
          : [],
      },
    };
  });
  const contactUserGet = vi.fn(async () => {
    if (params.contactError) {
      throw params.contactError;
    }
    return { data: { user: params.contactName ? { name: params.contactName } : {} } };
  });
  return {
    client: {
      im: { chatMembers: { get: chatMembersGet } },
      contact: { user: { get: contactUserGet } },
    },
    chatMembersGet,
    contactUserGet,
  };
}

describe("resolveFeishuSenderName", () => {
  const log = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    clearFeishuSenderNameCache();
  });

  it("prefers direct chat member display names before contact fallback", async () => {
    const account = makeAccount("default");
    const { client, chatMembersGet, contactUserGet } = mockClient({
      memberId: "ou_sender",
      memberName: "DM Sender",
      contactName: "Contact Sender",
    });
    mockCreateFeishuClient.mockReturnValue(client);

    const first = await resolveFeishuSenderName({
      account,
      senderId: "ou_sender",
      chatId: "oc_dm",
      chatType: "p2p",
      log,
    });
    const second = await resolveFeishuSenderName({
      account,
      senderId: "ou_sender",
      chatId: "oc_dm",
      chatType: "p2p",
      log,
    });

    expect(first.name).toBe("DM Sender");
    expect(second.name).toBe("DM Sender");
    expect(chatMembersGet).toHaveBeenCalledTimes(1);
    expect(contactUserGet).not.toHaveBeenCalled();
  });

  it("falls back to contact user names when direct members have no name", async () => {
    const account = makeAccount("default");
    const { client, contactUserGet } = mockClient({ contactName: "Contact Sender" });
    mockCreateFeishuClient.mockReturnValue(client);

    await expect(
      resolveFeishuSenderName({
        account,
        senderId: "ou_sender",
        chatId: "oc_dm",
        chatType: "p2p",
        log,
      }),
    ).resolves.toEqual({ name: "Contact Sender" });
    expect(contactUserGet).toHaveBeenCalledOnce();
  });

  it("scopes direct member caches by account", async () => {
    const accountA = makeAccount("acct_a");
    const accountB = makeAccount("acct_b");
    const clientA = mockClient({ memberId: "ou_sender", memberName: "Alice A" });
    const clientB = mockClient({ memberId: "ou_sender", memberName: "Alice B" });
    mockCreateFeishuClient.mockReturnValueOnce(clientA.client).mockReturnValueOnce(clientB.client);

    await expect(
      resolveFeishuSenderName({
        account: accountA,
        senderId: "ou_sender",
        chatId: "oc_dm",
        chatType: "p2p",
        log,
      }),
    ).resolves.toEqual({ name: "Alice A" });
    await expect(
      resolveFeishuSenderName({
        account: accountB,
        senderId: "ou_sender",
        chatId: "oc_dm",
        chatType: "p2p",
        log,
      }),
    ).resolves.toEqual({ name: "Alice B" });
  });

  it("scopes contact sender caches by account", async () => {
    const accountA = makeAccount("acct_a");
    const accountB = makeAccount("acct_b");
    const clientA = mockClient({ contactName: "Contact A" });
    const clientB = mockClient({ contactName: "Contact B" });
    mockCreateFeishuClient.mockReturnValueOnce(clientA.client).mockReturnValueOnce(clientB.client);

    await expect(
      resolveFeishuSenderName({ account: accountA, senderId: "ou_sender", log }),
    ).resolves.toEqual({ name: "Contact A" });
    await expect(
      resolveFeishuSenderName({ account: accountB, senderId: "ou_sender", log }),
    ).resolves.toEqual({ name: "Contact B" });
  });

  it("propagates direct-member permission guidance when contact fallback has no name", async () => {
    const account = makeAccount("default");
    const { client } = mockClient({
      memberError: {
        response: {
          data: {
            code: 99991672,
            msg: "permission denied https://open.feishu.cn/app/cli_default",
          },
        },
      },
    });
    mockCreateFeishuClient.mockReturnValue(client);

    const result = await resolveFeishuSenderName({
      account,
      senderId: "ou_sender",
      chatId: "oc_dm",
      chatType: "p2p",
      log,
    });

    expect(result.permissionError).toEqual(
      expect.objectContaining({
        code: 99991672,
        grantUrl: "https://open.feishu.cn/app/cli_default",
      }),
    );
  });

  it("keeps direct-member permission guidance when contact fallback hits stale contact scope", async () => {
    const account = makeAccount("default");
    const { client } = mockClient({
      memberError: {
        response: {
          data: {
            code: 99991672,
            msg: "permission denied https://open.feishu.cn/app/cli_default",
          },
        },
      },
      contactError: {
        response: {
          data: {
            code: 99991672,
            msg: "permission denied: contact:contact.base:readonly https://open.feishu.cn/app/cli_default",
          },
        },
      },
    });
    mockCreateFeishuClient.mockReturnValue(client);

    const result = await resolveFeishuSenderName({
      account,
      senderId: "ou_sender",
      chatId: "oc_dm",
      chatType: "p2p",
      log,
    });

    expect(result.permissionError).toEqual(
      expect.objectContaining({
        code: 99991672,
        grantUrl: "https://open.feishu.cn/app/cli_default",
      }),
    );
  });
});
