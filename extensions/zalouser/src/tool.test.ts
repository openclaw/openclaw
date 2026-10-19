import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { beforeEach, expect, it, vi } from "vitest";
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

const send = vi.mocked(sendMessageZalouser);
const image = vi.mocked(sendImageZalouser);
const link = vi.mocked(sendZaloLink);
const auth = vi.mocked(checkZaloAuthenticated);
const me = vi.mocked(getZaloUserInfo);
const friends = vi.mocked(listZaloFriendsMatching);
const groups = vi.mocked(listZaloGroupsMatching);
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
  { name: "ambient target", params: textMessage, target: "g-ambient", isGroup: true },
  {
    name: "explicit target",
    params: { ...textMessage, threadId: "u-explicit", isGroup: false },
    target: "u-explicit",
    isGroup: false,
  },
])("sends to the $name", async ({ params, target, isGroup }) => {
  send.mockResolvedValueOnce(sent("m-1"));
  expect(await execute(params, ambient)).toEqual({ success: true, messageId: "m-1" });
  expect(send).toHaveBeenCalledWith(target, "hello", { profile: undefined, isGroup });
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
  {
    action: "image",
    mock: image,
    threadId: "g-1",
    url: "https://example.com/image.jpg",
    message: "caption",
    isGroup: true,
    options: { mediaMaxBytes: undefined },
  },
  {
    action: "link",
    mock: link,
    threadId: "t-2",
    url: "https://openclaw.ai",
    message: "read this",
    isGroup: undefined,
    options: {},
  },
])(
  "routes $action to its sender",
  async ({ action, mock, threadId, url, message, isGroup, options }) => {
    mock.mockResolvedValueOnce(sent("media-1"));
    expect(await execute({ action, threadId, url, message, isGroup })).toEqual({
      success: true,
      messageId: "media-1",
    });
    expect(mock).toHaveBeenCalledWith(threadId, url, {
      profile: undefined,
      caption: message,
      isGroup,
      ...options,
    });
  },
);

it.each([
  ["matching credential profile with different case", " WORK ", 2048],
  ["native default profile", undefined, 1024],
] as const)("uses the authoritative media account: %s", async (_name, profile, bytes) => {
  image.mockResolvedValueOnce(sent("cap"));
  const runtimeConfig = {
    channels: {
      zalouser: {
        mediaMaxMb: 1 / 1024,
        accounts: {
          support: { profile: "work", mediaMaxMb: 2 / 1024 },
          duplicate: { profile: "work", mediaMaxMb: 1 / 1048576 },
        },
      },
    },
  };
  await execute(
    { action: "image", threadId: "123", url: "https://example.com/image.png", profile },
    { runtimeConfig, deliveryContext: { channel: "zalouser", accountId: "support" } },
  );
  expect(image).toHaveBeenCalledWith(
    "123",
    "https://example.com/image.png",
    expect.objectContaining({ profile, mediaMaxBytes: bytes }),
  );
});

it.each([
  {
    action: "friends",
    query: "ali",
    mock: friends,
    expected: [{ userId: "1", displayName: "Alice" }],
    setup: () => friends.mockResolvedValueOnce([{ userId: "1", displayName: "Alice" }]),
  },
  {
    action: "groups",
    query: "wrk",
    mock: groups,
    expected: [{ groupId: "2", name: "Work" }],
    setup: () => groups.mockResolvedValueOnce([{ groupId: "2", name: "Work" }]),
  },
])("returns matching $action", async ({ action, query, mock, expected, setup }) => {
  setup();
  expect(await execute({ action, profile: "work", query })).toEqual(expected);
  expect(mock).toHaveBeenCalledWith("work", query);
});

it.each([
  {
    action: "me",
    mock: me,
    expected: { userId: "7", displayName: "Me" },
    setup: () => me.mockResolvedValueOnce({ userId: "7", displayName: "Me" }),
  },
  {
    action: "status",
    mock: auth,
    expected: { authenticated: true, output: "authenticated" },
    setup: () => auth.mockResolvedValueOnce(true),
  },
])("reports $action", async ({ action, mock, expected, setup }) => {
  setup();
  expect(await execute({ action, profile: "work" })).toEqual(expected);
  expect(mock).toHaveBeenCalledWith("work");
});
