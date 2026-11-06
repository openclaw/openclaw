import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { beforeEach, expect, it, vi } from "vitest";
import { createZalouserSendReceipt } from "./send-receipt.js";
import { createZalouserTool } from "./tool.js";

const { send, image, link, auth, me, friends, groups } = vi.hoisted(() => ({
  send: vi.fn<typeof import("./send.js").sendMessageZalouser>(),
  image: vi.fn<typeof import("./send.js").sendImageZalouser>(),
  link: vi.fn<typeof import("./zalo-js.js").sendZaloLink>(),
  auth: vi.fn<typeof import("./zalo-js.js").checkZaloAuthenticated>(),
  me: vi.fn<typeof import("./zalo-js.js").getZaloUserInfo>(),
  friends: vi.fn<typeof import("./zalo-js.js").listZaloFriendsMatching>(),
  groups: vi.fn<typeof import("./zalo-js.js").listZaloGroupsMatching>(),
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageZalouser: send,
  sendImageZalouser: image,
}));
// mock-isolation: Keep account lookup, login, and message transport inside the test fixture.
vi.mock("./zalo-js.js", () => ({
  checkZaloAuthenticated: auth,
  getZaloUserInfo: me,
  listZaloFriendsMatching: friends,
  listZaloGroupsMatching: groups,
  sendZaloLink: link,
}));

const ambient = { deliveryContext: { channel: "zalouser", to: "zalouser:g-ambient" } };
const textMessage = { action: "send", message: "hello" };
const sent = (messageId: string) => ({
  messageId,
  receipt: createZalouserSendReceipt({ messageId }),
});

async function execute(
  params: Parameters<ReturnType<typeof createZalouserTool>["execute"]>[1],
  context?: Parameters<typeof createZalouserTool>[0],
) {
  const result = await createZalouserTool(context).execute("tool-1", params);
  const content = result.content?.[0];
  return JSON.parse(content?.type === "text" ? content.text : "{}") as unknown;
}

beforeEach(() => {
  [send, image, link, auth, me, friends, groups].forEach((mock) => mock.mockReset());
});

it.each([
  ["send", send, {}, "g-ambient", true],
  ["send", send, { threadId: "u-explicit", isGroup: false }, "u-explicit", false],
  ["image", image, { threadId: "g-1", isGroup: true }, "g-1", true],
  ["link", link, { threadId: "t-2" }, "t-2", undefined],
] as const)("routes %s to its sender", async (action, mock, overrides, target, isGroup) => {
  mock.mockResolvedValueOnce(sent("m-1"));
  expect(
    await execute(
      { action, message: "hello", url: "https://example.com", ...overrides },
      action === "send" ? ambient : undefined,
    ),
  ).toEqual({ success: true, messageId: "m-1" });
  expect(mock).toHaveBeenCalledWith(target, action === "send" ? "hello" : "https://example.com", {
    profile: undefined,
    isGroup,
    ...(action === "send" ? {} : { caption: "hello" }),
    ...(action === "image" ? { mediaMaxBytes: undefined } : {}),
  });
});

it("does not route send actions from foreign ambient thread defaults", async () => {
  expect(
    await execute(textMessage, {
      deliveryContext: { channel: "slack", to: "channel:C123", threadId: "1710000000.000100" },
    }),
  ).toEqual({ error: "threadId and message required for send action" });
  expect(send).not.toHaveBeenCalled();
});

it("returns tool error when send action fails", async () => {
  send.mockRejectedValueOnce(new Error("blocked"));
  expect(await execute({ ...textMessage, threadId: "t-1" })).toEqual({ error: "blocked" });
});

it("reports accepted receipts when a later send chunk fails", async () => {
  const deliveryResult = {
    messageIds: ["mid-accepted"],
    receipt: createZalouserSendReceipt({ messageId: "mid-accepted", threadId: "t-1" }),
    visibleReplySent: true as const,
  };
  send.mockRejectedValueOnce(
    createChannelPartialDeliveryError(new Error("later chunk refused"), deliveryResult),
  );
  expect(await execute({ action: "send", threadId: "t-1", message: "long message" })).toEqual({
    ok: false,
    deliveryStatus: "partial_failed",
    sentBeforeError: true,
    error: "later chunk refused",
    result: deliveryResult,
  });
});

it.each([
  ["matching credential profile with different case", " WORK ", 2048],
  ["native default profile", undefined, 1024],
] as const)("uses the authoritative media account: %s", async (_name, profile, bytes) => {
  image.mockResolvedValueOnce(sent("cap"));
  const zalouser = {
    mediaMaxMb: 1 / 1024,
    accounts: {
      support: { profile: "work", mediaMaxMb: 2 / 1024 },
      duplicate: { profile: "work", mediaMaxMb: 1 / 1048576 },
    },
  };
  await execute(
    { action: "image", threadId: "123", url: "https://example.com/image.png", profile },
    {
      runtimeConfig: { channels: { zalouser } },
      deliveryContext: { channel: "zalouser", accountId: "support" },
    },
  );
  expect(image).toHaveBeenCalledWith(
    "123",
    "https://example.com/image.png",
    expect.objectContaining({ profile, mediaMaxBytes: bytes }),
  );
});

const friendRows = [{ userId: "1", displayName: "Alice" }];
const groupRows = [{ groupId: "2", name: "Work" }];
const userInfo = { userId: "7", displayName: "Me" };
const authenticated = { authenticated: true, output: "authenticated" };
it.each([
  ["friends", "ali", friends, friendRows, () => friends.mockResolvedValueOnce(friendRows)],
  ["groups", "wrk", groups, groupRows, () => groups.mockResolvedValueOnce(groupRows)],
  ["me", undefined, me, userInfo, () => me.mockResolvedValueOnce(userInfo)],
  ["status", undefined, auth, authenticated, () => auth.mockResolvedValueOnce(true)],
] as const)("returns %s", async (action, query, mock, expected, setup) => {
  setup();
  expect(await execute({ action, profile: "work", query })).toEqual(expected);
  expect(mock).toHaveBeenCalledWith(...(query === undefined ? ["work"] : ["work", query]));
});
