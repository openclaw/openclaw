import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createZalouserSendReceipt } from "./send-receipt.js";
import { sendImageZalouser, sendMessageZalouser } from "./send.js";
import { createZalouserTool } from "./tool.js";
import {
  checkZaloAuthenticated,
  getZaloUserInfo,
  listZaloFriendsMatching,
  listZaloGroupsMatching,
  sendZaloLink,
} from "./zalo-js.js";

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageZalouser: vi.fn(),
  sendImageZalouser: vi.fn(),
}));

vi.mock("./zalo-js.js", () => ({
  checkZaloAuthenticated: vi.fn(),
  getZaloUserInfo: vi.fn(),
  listZaloFriendsMatching: vi.fn(),
  listZaloGroupsMatching: vi.fn(),
  sendZaloLink: vi.fn(),
}));

const mockSendMessage = vi.mocked(sendMessageZalouser);
const mockSendImage = vi.mocked(sendImageZalouser);
const mockSendLink = vi.mocked(sendZaloLink);
const mockCheckAuth = vi.mocked(checkZaloAuthenticated);
const mockGetUserInfo = vi.mocked(getZaloUserInfo);
const mockListFriends = vi.mocked(listZaloFriendsMatching);
const mockListGroups = vi.mocked(listZaloGroupsMatching);

async function execute(
  params: Parameters<ReturnType<typeof createZalouserTool>["execute"]>[1],
  context?: Parameters<typeof createZalouserTool>[0],
) {
  const result = await createZalouserTool(context).execute("tool-1", params);
  const content = result.content?.[0];
  return JSON.parse(content?.type === "text" ? content.text : "{}") as unknown;
}

const textMessage = { action: "send", message: "hello" };
const ambient = { deliveryContext: { channel: "zalouser", to: "zalouser:g-ambient" } };
const sent = (messageId: string) => ({
  messageId,
  receipt: createZalouserSendReceipt({ messageId }),
});

describe("execute", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockSendImage.mockReset();
    mockSendLink.mockReset();
    mockCheckAuth.mockReset();
    mockGetUserInfo.mockReset();
    mockListFriends.mockReset();
    mockListGroups.mockReset();
  });

  it("defaults send routing from ambient deliveryContext target", async () => {
    mockSendMessage.mockResolvedValueOnce(sent("m-ambient"));
    const result = await execute(textMessage, ambient);

    expect(mockSendMessage).toHaveBeenCalledWith("g-ambient", "hello", {
      profile: undefined,
      isGroup: true,
    });
    expect(result).toEqual({ success: true, messageId: "m-ambient" });
  });

  it("keeps explicit threadId over ambient delivery defaults", async () => {
    mockSendMessage.mockResolvedValueOnce(sent("m-explicit"));
    await execute(
      {
        ...textMessage,
        threadId: "u-explicit",
        isGroup: false,
      },
      ambient,
    );

    expect(mockSendMessage).toHaveBeenCalledWith("u-explicit", "hello", {
      profile: undefined,
      isGroup: false,
    });
  });

  it("does not route send actions from foreign ambient thread defaults", async () => {
    const result = await execute(textMessage, {
      deliveryContext: {
        channel: "slack",
        to: "channel:C123",
        threadId: "1710000000.000100",
      },
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: "threadId and message required for send action",
    });
  });

  it("returns tool error when send action fails", async () => {
    mockSendMessage.mockRejectedValueOnce(new Error("blocked"));
    const result = await execute({
      ...textMessage,
      threadId: "t-1",
    });
    expect(result).toEqual({ error: "blocked" });
  });

  it("reports accepted receipts when a later send chunk fails", async () => {
    const deliveryResult = {
      messageIds: ["mid-accepted"],
      receipt: createZalouserSendReceipt({ messageId: "mid-accepted", threadId: "t-1" }),
      visibleReplySent: true as const,
    };
    mockSendMessage.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("later chunk refused"), deliveryResult),
    );

    const result = await execute({
      action: "send",
      threadId: "t-1",
      message: "long message",
    });

    expect(result).toEqual({
      ok: false,
      deliveryStatus: "partial_failed",
      sentBeforeError: true,
      error: "later chunk refused",
      result: deliveryResult,
    });
  });

  it("routes image and link actions to correct helpers", async () => {
    mockSendImage.mockResolvedValueOnce(sent("img-1"));
    const imageResult = await execute({
      action: "image",
      threadId: "g-1",
      url: "https://example.com/image.jpg",
      message: "caption",
      isGroup: true,
    });
    expect(mockSendImage).toHaveBeenCalledWith("g-1", "https://example.com/image.jpg", {
      profile: undefined,
      mediaMaxBytes: undefined,
      caption: "caption",
      isGroup: true,
    });
    expect(imageResult).toEqual({ success: true, messageId: "img-1" });

    mockSendLink.mockResolvedValueOnce(sent("lnk-1"));
    const linkResult = await execute({
      action: "link",
      threadId: "t-2",
      url: "https://openclaw.ai",
      message: "read this",
    });
    expect(mockSendLink).toHaveBeenCalledWith("t-2", "https://openclaw.ai", {
      profile: undefined,
      caption: "read this",
      isGroup: undefined,
    });
    expect(linkResult).toEqual({ success: true, messageId: "lnk-1" });
  });

  it.each([
    {
      name: "matching credential profile with different case",
      deliveryContext: { channel: "zalouser", accountId: "support" },
      profile: " WORK ",
      bytes: 2048,
    },
    {
      name: "native default profile",
      deliveryContext: { channel: "zalouser", accountId: "support" },
      profile: undefined,
      bytes: 1024,
    },
  ])(
    "uses only the authoritative matching media account: $name",
    async ({ deliveryContext, profile, bytes }) => {
      mockSendImage.mockResolvedValueOnce(sent("cap"));
      await execute(
        {
          action: "image",
          threadId: "123",
          url: "https://example.com/image.png",
          profile,
        },
        {
          runtimeConfig: {
            channels: {
              zalouser: {
                mediaMaxMb: 1 / 1024,
                accounts: {
                  support: { profile: "work", mediaMaxMb: 2 / 1024 },
                  duplicate: { profile: "work", mediaMaxMb: 1 / 1048576 },
                },
              },
            },
          },
          deliveryContext,
        },
      );
      expect(mockSendImage).toHaveBeenCalledWith(
        "123",
        "https://example.com/image.png",
        expect.objectContaining({
          profile,
          mediaMaxBytes: bytes,
        }),
      );
    },
  );

  it("returns friends/groups lists", async () => {
    mockListFriends.mockResolvedValueOnce([{ userId: "1", displayName: "Alice" }]);
    mockListGroups.mockResolvedValueOnce([{ groupId: "2", name: "Work" }]);

    const friends = await execute({
      action: "friends",
      profile: "work",
      query: "ali",
    });
    expect(mockListFriends).toHaveBeenCalledWith("work", "ali");
    expect(friends).toEqual([{ userId: "1", displayName: "Alice" }]);

    const groups = await execute({
      action: "groups",
      profile: "work",
      query: "wrk",
    });
    expect(mockListGroups).toHaveBeenCalledWith("work", "wrk");
    expect(groups).toEqual([{ groupId: "2", name: "Work" }]);
  });

  it("reports me + status actions", async () => {
    mockGetUserInfo.mockResolvedValueOnce({ userId: "7", displayName: "Me" });
    mockCheckAuth.mockResolvedValueOnce(true);

    const me = await execute({ action: "me", profile: "work" });
    expect(mockGetUserInfo).toHaveBeenCalledWith("work");
    expect(me).toEqual({ userId: "7", displayName: "Me" });

    const status = await execute({ action: "status", profile: "work" });
    expect(mockCheckAuth).toHaveBeenCalledWith("work");
    expect(status).toEqual({
      authenticated: true,
      output: "authenticated",
    });
  });
});
