import type { WebClient } from "@slack/web-api";
import { beforeEach, expect, it, vi } from "vitest";
import { downloadSlackFile } from "./actions.js";

const resolveSlackMedia = vi.fn<typeof import("./monitor/media.js").resolveSlackMedia>();
const createSlackLookupClientMock = vi.hoisted(() => vi.fn());
vi.mock("./monitor/media.js", () => ({
  resolveSlackMedia: (...args: Parameters<typeof resolveSlackMedia>) => resolveSlackMedia(...args),
}));
vi.mock("./client.js", () => ({
  createSlackLookupClient: createSlackLookupClientMock,
  getSlackWriteClient: vi.fn(),
}));

function createClient(file: Record<string, unknown> = {}) {
  const info = vi.fn(async () => ({ file: {} })).mockResolvedValueOnce({ file: fileInfo(file) });
  return { files: { info } } as unknown as WebClient & {
    files: { info: ReturnType<typeof vi.fn> };
  };
}
const fileMetadata = {
  id: "F123",
  name: "image.png",
  mimetype: "image/png",
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

it("uses cfg credentials and the prepared GovSlack client for fresh scoped metadata", async () => {
  const client = Object.assign(
    createClient({ channels: ["C999"], ims: ["C123"], has_more_shares: true }),
    { slackApiUrl: "https://slack-gov.com/api/" },
  );
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
  expect(createSlackLookupClientMock).toHaveBeenCalledWith(
    "xoxb-from-cfg",
    { teamId: undefined },
    undefined,
  );
  expect(resolveSlackMedia).toHaveBeenCalledExactlyOnceWith({
    files: [{ ...fileMetadata, url_private: undefined }],
    client,
    token: "xoxb-from-cfg",
    maxBytes: 1024,
    isRefreshedFileAllowed: expect.any(Function),
  });
});

it("reapplies channel and thread admission when download metadata is refreshed", async () => {
  const client = createClient(privateShare("C123", "111.111"));
  await expect(download(client, { threadId: "111.111" })).resolves.toEqual(media);
  const isAllowed = resolveSlackMedia.mock.calls[0]?.[0].isRefreshedFileAllowed;
  if (!isAllowed) {
    throw new Error("Expected refreshed Slack file admission");
  }
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
  const client = createClient(file);
  await expect(download(client, { threadId, channelId: channelId ?? "C123" })).resolves.toBeNull();
  expect(resolveSlackMedia).not.toHaveBeenCalled();
});
