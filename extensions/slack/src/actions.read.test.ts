import type { WebClient } from "@slack/web-api";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { downloadSlackFile, readSlackMessages } from "./actions.js";

const createSlackLookupClientMock = vi.hoisted(() => vi.fn());
const resolveSlackMedia = vi.fn<typeof import("./monitor/media.js").resolveSlackMedia>();
vi.mock("./monitor/media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor/media.js")>()),
  resolveSlackMedia: (...args: Parameters<typeof resolveSlackMedia>) => resolveSlackMedia(...args),
}));
vi.mock("./client.js", () => ({
  createSlackLookupClient: createSlackLookupClientMock,
  getSlackWriteClient: vi.fn(),
}));
function createClient() {
  return {
    conversations: { replies: vi.fn(), history: vi.fn() },
  } as unknown as WebClient & {
    conversations: { replies: ReturnType<typeof vi.fn>; history: ReturnType<typeof vi.fn> };
  };
}
type Bounds = { oldest?: string; latest?: string; inclusive?: boolean; limit?: number };
function threadClient(echoRoot: boolean) {
  const client = createClient();
  const messages = Array.from({ length: 102 }, (_, index) => ({
    ts: "171234." + String(index).padStart(6, "0"),
    text: index === 101 ? "requested reply" : "message " + String(index),
  }));
  client.conversations.replies.mockImplementation(
    ({ oldest, latest, inclusive, limit }: Bounds) => {
      if (echoRoot) {
        return { messages: messages.slice(0, 2), has_more: false };
      }
      const eligible = messages.filter(
        (message) =>
          (!oldest || message.ts > oldest || (inclusive && message.ts === oldest)) &&
          (!latest || message.ts < latest || (inclusive && message.ts === latest)),
      );
      return { messages: eligible.slice(0, limit), has_more: eligible.length > (limit ?? 0) };
    },
  );
  return client;
}

it.each([
  ["excludes the parent before applying the thread page limit", false, false],
  ["reads an exact reply beyond the first thread page", true, false],
  ["keeps explicit reply bounds and drops an echoed root", false, true],
] as const)("%s", async (_name, exact, echoRoot) => {
  const client = threadClient(echoRoot);
  const ts = exact ? "171234.000101" : "171234.000001";
  await expect(
    readSlackMessages("C1", {
      client,
      threadId: "171234.000000",
      ...(exact
        ? { messageId: ts, limit: 20 }
        : {
            after: echoRoot ? "171234.0000001" : "171233.000000",
            before: echoRoot ? "171235.000001" : undefined,
            limit: 1,
          }),
    }),
  ).resolves.toEqual({
    messages: [{ ts, text: exact ? "requested reply" : "message 1" }],
    hasMore: !exact && !echoRoot,
  });
  if (echoRoot) {
    expect(client.conversations.replies.mock.calls[0]?.[0]).toMatchObject({
      oldest: "171234.0000001",
      latest: "171235.000001",
    });
  }
});

function createFileClient(file: Record<string, unknown> = {}) {
  const info = vi.fn(async () => ({ file: {} })).mockResolvedValueOnce({ file: fileInfo(file) });
  return { files: { info } } as unknown as WebClient;
}
const fileMetadata = {
  url_private_download: "https://files.slack-gov.com/files-pri/T1-F123/image.png",
};
function fileInfo(overrides: Record<string, unknown> = {}) {
  return { ...fileMetadata, channels: ["C123"], ...overrides };
}
function privateShare(channel: string, ts: string, thread_ts?: string) {
  return { shares: { private: { [channel]: [{ ts, ...(thread_ts ? { thread_ts } : {}) }] } } };
}
const media = { path: "/tmp/a.png", contentType: "image/png", placeholder: "[file]" };
function download(
  client: WebClient,
  overrides: Partial<Parameters<typeof downloadSlackFile>[1]> = {},
) {
  return downloadSlackFile("F123", {
    client,
    token: "xoxb-test",
    maxBytes: 1024,
    channelId: "C123",
    ...overrides,
  });
}

beforeEach(() => {
  resolveSlackMedia.mockReset().mockResolvedValueOnce([media]);
  createSlackLookupClientMock.mockReset();
});

it("uses cfg credentials and the prepared lookup client for fresh scoped metadata", async () => {
  const client = createFileClient({ channels: ["C999"], ims: ["C123"] });
  createSlackLookupClientMock.mockReturnValueOnce(client);
  await expect(
    downloadSlackFile("F123", {
      cfg: { channels: { slack: { accounts: { default: { botToken: "xoxb-from-cfg" } } } } },
      accountId: "default",
      maxBytes: 1024,
      channelId: "C123",
    }),
  ).resolves.toEqual(media);
  expect(client.files.info).toHaveBeenCalledExactlyOnceWith({ file: "F123" });
  expect(createSlackLookupClientMock.mock.calls[0]?.[0]).toBe("xoxb-from-cfg");
  expect(resolveSlackMedia.mock.calls[0]?.[0]).toMatchObject({
    client,
    token: "xoxb-from-cfg",
    maxBytes: 1024,
  });
});

it("reapplies channel and thread admission when download metadata is refreshed", async () => {
  const client = createFileClient(privateShare("C123", "111.111"));
  await expect(download(client, { threadId: "111.111" })).resolves.toEqual(media);
  const isAllowed = resolveSlackMedia.mock.calls[0]?.[0].isRefreshedFileAllowed;
  assert(isAllowed, "Expected refreshed Slack file admission");
  expect(isAllowed(fileInfo(privateShare("C123", "222.222", "111.111")))).toBe(true);
  expect(isAllowed(fileInfo(privateShare("C999", "111.111")))).toBe(false);
  expect(isAllowed(fileInfo(privateShare("C123", "222.222")))).toBe(false);
});

it.each<[string, Record<string, unknown>, string?, string?]>([
  ["missing private URL", { url_private_download: undefined }],
  ["wrong channel", { channels: ["C999"] }],
  ["wrong thread", privateShare("C123", "111.111", "111.111"), "222.222"],
  ["shares without timestamps", { channels: undefined, shares: { private: { C123: [{}] } } }],
  ["blank requested channel", {}, undefined, "   "],
])("rejects %s before downloading", async (_name, file, threadId, channelId) => {
  const client = createFileClient(file);
  await expect(download(client, { threadId, channelId: channelId ?? "C123" })).resolves.toBeNull();
  expect(resolveSlackMedia).not.toHaveBeenCalled();
});

it("reads ISO-bounded channel history through the lookup client and preserves table payloads", async () => {
  const client = createClient();
  const token = "test-auth-token";
  const rawText = (text: string) => ({ type: "raw_text", text });
  const blocks = [
    {
      type: "table",
      rows: [
        [rawText("ID"), rawText("Status")],
        [{ type: "raw_number", value: 12345 }, rawText("enabled")],
      ],
    },
  ];
  const attachments = [{ fallback: "[no preview available]", blocks }];
  client.conversations.history.mockResolvedValueOnce({
    messages: [{ ts: "1", text: "  Please check these.  ", attachments }],
    has_more: false,
  });
  createSlackLookupClientMock.mockReturnValueOnce(client);
  const result = await readSlackMessages("C1", {
    token,
    cfg: { channels: { slack: { enabled: true, botToken: token } } },
    before: "2024-04-05T12:34:56+03:00",
    after: "2024-04-05T12:34:56.789+03:00",
  });
  expect(createSlackLookupClientMock).toHaveBeenCalledWith(token, { teamId: undefined }, undefined);
  expect(client.conversations.history.mock.calls[0]?.[0]).toMatchObject({
    latest: "1712309696",
    oldest: "1712309696.789",
  });
  expect(result.messages[0]?.text).toBe("  Please check these.  \nID\tStatus\n12345\tenabled");
  expect(result.messages[0]?.attachments).toBe(attachments);
  expect(result.hasMore).toBe(false);
});

it("rejects invalid history bounds before Slack API work", async () => {
  const client = createClient();
  await expect(
    readSlackMessages("C1", { client, before: "2024-02-30T00:00:00.000Z" }),
  ).rejects.toThrow(
    'Invalid Slack read before timestamp "2024-02-30T00:00:00.000Z": expected a Slack timestamp or ISO-8601 date string',
  );
  expect(client.conversations.history).not.toHaveBeenCalled();
});
