import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());

// mock-isolation: Action fixtures provide account selection without loading real credentials.
vi.mock("./accounts.js", () => ({
  inspectGoogleChatAccount: vi.fn(),
  listGoogleChatAccountIds: vi.fn(),
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace,
}));

let googlechatMessageActions: typeof import("./message-tool-api.js").googlechatMessageActions;
const remoteMedia = "https://example.invalid/image.png";
const link = `Attachment: ${remoteMedia}`;

beforeAll(async () => {
  ({ googlechatMessageActions } = await import("./message-tool-api.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveGoogleChatAccount.mockReturnValue({ credentialSource: "service-account" });
  resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
});

afterAll(() => {
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./api.js");
  vi.doUnmock("./targets.js");
  vi.resetModules();
});

function send(params: Record<string, unknown>, action = "send") {
  return googlechatMessageActions.handleAction({
    action,
    params,
    cfg: {},
    accountId: "default",
  } as never);
}

it("supports only send actions", () => {
  expect(googlechatMessageActions.supportsAction?.({ action: "send" })).toBe(true);
  expect(googlechatMessageActions.supportsAction?.({ action: "upload-file" })).toBe(false);
});

it.each([
  ["caption", undefined, "thread-1", "caption"],
  [undefined, remoteMedia, undefined, link],
  ["caption", remoteMedia, undefined, `caption\n\n${link}`],
])("sends %s through the resolved space", async (message, media, thread, text) => {
  sendGoogleChatMessage.mockResolvedValue({
    messageName: "spaces/AAA/messages/msg-1",
    threadName: "spaces/AAA/threads/thread-1",
  });

  const result = await send({ to: "spaces/AAA", message, media, threadId: thread });
  expect(sendGoogleChatMessage.mock.lastCall?.[0]).toMatchObject({
    space: "spaces/AAA",
    text,
    thread,
  });
  expect(result.details).toEqual({
    ok: true,
    to: "spaces/AAA",
    messageName: "spaces/AAA/messages/msg-1",
    threadName: "spaces/AAA/threads/thread-1",
  });
});

it.each([
  { media: "remote.png" },
  { mediaUrls: ["remote.png"] },
  { attachments: [{ url: "remote.png" }] },
])("rejects local attachments %j before provider access", async (media) => {
  await expect(send({ to: "spaces/AAA", message: "caption", ...media })).rejects.toThrow(
    "Google Chat outbound attachments require remote HTTP(S) URLs.",
  );

  expect(resolveGoogleChatAccount).not.toHaveBeenCalled();
  expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
  expect(sendGoogleChatMessage).not.toHaveBeenCalled();
});

it("rejects unsupported actions without provider access", async () => {
  await expect(send({}, "react")).rejects.toThrow(
    "Action react is not supported for provider googlechat.",
  );

  expect(sendGoogleChatMessage).not.toHaveBeenCalled();
});
