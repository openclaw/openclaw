import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendImageZalouser, sendLinkZalouser, sendMessageZalouser } from "./send.js";
import { executeZalouserTool } from "./tool.js";
import {
  checkZaloAuthenticated,
  getZaloUserInfo,
  listZaloFriendsMatching,
  listZaloGroupsMatching,
} from "./zalo-js.js";

vi.mock("./send.js", () => ({
  sendMessageZalouser: vi.fn(),
  sendImageZalouser: vi.fn(),
  sendLinkZalouser: vi.fn(),
}));

vi.mock("./zalo-js.js", () => ({
  checkZaloAuthenticated: vi.fn(),
  getZaloUserInfo: vi.fn(),
  listZaloFriendsMatching: vi.fn(),
  listZaloGroupsMatching: vi.fn(),
}));

const mockSendMessage = vi.mocked(sendMessageZalouser);
const mockSendImage = vi.mocked(sendImageZalouser);
const mockSendLink = vi.mocked(sendLinkZalouser);
const mockCheckAuth = vi.mocked(checkZaloAuthenticated);
const mockGetUserInfo = vi.mocked(getZaloUserInfo);
const mockListFriends = vi.mocked(listZaloFriendsMatching);
const mockListGroups = vi.mocked(listZaloGroupsMatching);

function extractDetails(result: Awaited<ReturnType<typeof executeZalouserTool>>): unknown {
  const text = result.content[0]?.text ?? "{}";
  return JSON.parse(text) as unknown;
}

describe("executeZalouserTool", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockSendImage.mockReset();
    mockSendLink.mockReset();
    mockCheckAuth.mockReset();
    mockGetUserInfo.mockReset();
    mockListFriends.mockReset();
    mockListGroups.mockReset();
  });

  it("returns error when send action is missing required fields", async () => {
    const result = await executeZalouserTool("tool-1", { action: "send" });
    expect(extractDetails(result)).toEqual({
      error: "threadId and message required for send action",
    });
  });

  it("sends text message for send action", async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, messageId: "m-1" });
    const result = await executeZalouserTool("tool-1", {
      action: "send",
      threadId: "t-1",
      message: "hello",
      profile: "work",
      isGroup: true,
    });
    expect(mockSendMessage).toHaveBeenCalledWith("t-1", "hello", {
      profile: "work",
      isGroup: true,
    });
    expect(extractDetails(result)).toEqual({ success: true, messageId: "m-1" });
  });

  it("returns tool error when send action fails", async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: false, error: "blocked" });
    const result = await executeZalouserTool("tool-1", {
      action: "send",
      threadId: "t-1",
      message: "hello",
    });
    expect(extractDetails(result)).toEqual({ error: "blocked" });
  });

  it("routes image and link actions to correct helpers", async () => {
    mockSendImage.mockResolvedValueOnce({ ok: true, messageId: "img-1" });
    const imageResult = await executeZalouserTool("tool-1", {
      action: "image",
      threadId: "g-1",
      url: "https://example.com/image.jpg",
      message: "caption",
      isGroup: true,
    });
    expect(mockSendImage).toHaveBeenCalledWith("g-1", "https://example.com/image.jpg", {
      profile: undefined,
      caption: "caption",
      isGroup: true,
    });
    expect(extractDetails(imageResult)).toEqual({ success: true, messageId: "img-1" });

    mockSendLink.mockResolvedValueOnce({ ok: true, messageId: "lnk-1" });
    const linkResult = await executeZalouserTool("tool-1", {
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
    expect(extractDetails(linkResult)).toEqual({ success: true, messageId: "lnk-1" });
  });

  it("returns friends/groups lists", async () => {
    mockListFriends.mockResolvedValueOnce([{ userId: "1", displayName: "Alice" }]);
    mockListGroups.mockResolvedValueOnce([{ groupId: "2", name: "Work" }]);

    const friends = await executeZalouserTool("tool-1", {
      action: "friends",
      profile: "work",
      query: "ali",
    });
    expect(mockListFriends).toHaveBeenCalledWith("work", "ali");
    expect(extractDetails(friends)).toEqual([{ userId: "1", displayName: "Alice" }]);

    const groups = await executeZalouserTool("tool-1", {
      action: "groups",
      profile: "work",
      query: "wrk",
    });
    expect(mockListGroups).toHaveBeenCalledWith("work", "wrk");
    expect(extractDetails(groups)).toEqual([{ groupId: "2", name: "Work" }]);
  });

  it("reports me + status actions", async () => {
    mockGetUserInfo.mockResolvedValueOnce({ userId: "7", displayName: "Me" });
    mockCheckAuth.mockResolvedValueOnce(true);

    const me = await executeZalouserTool("tool-1", { action: "me", profile: "work" });
    expect(mockGetUserInfo).toHaveBeenCalledWith("work");
    expect(extractDetails(me)).toEqual({ userId: "7", displayName: "Me" });

    const status = await executeZalouserTool("tool-1", { action: "status", profile: "work" });
    expect(mockCheckAuth).toHaveBeenCalledWith("work");
    expect(extractDetails(status)).toEqual({
      authenticated: true,
      output: "authenticated",
    });
  });
});
