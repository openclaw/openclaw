import type { WebClient } from "@slack/web-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveSlackMedia = vi.fn<typeof import("./monitor/media.js").resolveSlackMedia>();
const createSlackLookupClientMock = vi.hoisted(() => vi.fn());
vi.mock("./monitor/media.js", () => ({
  resolveSlackMedia: (...args: Parameters<typeof resolveSlackMedia>) => resolveSlackMedia(...args),
}));
vi.mock("./client.js", () => ({
  createSlackLookupClient: createSlackLookupClientMock,
  getSlackWriteClient: vi.fn(),
}));
let downloadSlackFile: typeof import("./actions.js").downloadSlackFile;

function createClient() {
  return { files: { info: vi.fn(async () => ({ file: {} })) } } as unknown as WebClient & {
    files: { info: ReturnType<typeof vi.fn> };
  };
}
function fileInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: "F123",
    name: "image.png",
    mimetype: "image/png",
    url_private_download: "https://files.slack-gov.com/files-pri/T1-F123/image.png",
    channels: ["C123"],
    ...overrides,
  };
}
const media = {
  path: "/tmp/image.png",
  contentType: "image/png",
  placeholder: "[Slack file: image.png]",
};
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

describe("downloadSlackFile", () => {
  beforeAll(async () => {
    ({ downloadSlackFile } = await import("./actions.js"));
  });
  beforeEach(() => {
    resolveSlackMedia.mockReset().mockResolvedValueOnce([media]);
    createSlackLookupClientMock.mockReset();
  });

  it("uses cfg credentials and the prepared GovSlack client for fresh scoped metadata", async () => {
    const client = Object.assign(createClient(), { slackApiUrl: "https://slack-gov.com/api/" });
    client.files.info.mockResolvedValueOnce({
      file: fileInfo({
        channels: ["C999"],
        groups: undefined,
        ims: ["C123"],
        has_more_shares: true,
      }),
    });
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
      files: [
        {
          id: "F123",
          name: "image.png",
          mimetype: "image/png",
          url_private: undefined,
          url_private_download: "https://files.slack-gov.com/files-pri/T1-F123/image.png",
        },
      ],
      client,
      token: "xoxb-from-cfg",
      maxBytes: 1024,
      isRefreshedFileAllowed: expect.any(Function),
    });
  });

  it("accepts channel proof from share timestamps", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: fileInfo({ channels: undefined, shares: { private: { C123: [{ ts: "111.111" }] } } }),
    });
    await expect(download(client)).resolves.toEqual(media);
  });

  it("reapplies channel and thread admission when download metadata is refreshed", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: fileInfo({ shares: { private: { C123: [{ ts: "111.111" }] } } }),
    });
    await expect(download(client, { threadId: "111.111" })).resolves.toEqual(media);
    const isAllowed = resolveSlackMedia.mock.calls[0]?.[0].isRefreshedFileAllowed;
    if (!isAllowed) {
      throw new Error("Expected refreshed Slack file admission");
    }
    expect(
      isAllowed(
        fileInfo({ shares: { private: { C123: [{ ts: "222.222", thread_ts: "111.111" }] } } }),
      ),
    ).toBe(true);
    expect(isAllowed(fileInfo({ shares: { private: { C999: [{ ts: "111.111" }] } } }))).toBe(false);
    expect(isAllowed(fileInfo({ shares: { private: { C123: [{ ts: "222.222" }] } } }))).toBe(false);
  });

  it.each([
    { name: "missing private URL", file: { url_private_download: undefined } },
    { name: "wrong channel", file: { channels: ["C999"] } },
    { name: "channel proof without thread proof", file: {}, threadId: "222.222" },
    {
      name: "wrong thread",
      file: { shares: { private: { C123: [{ ts: "111.111", thread_ts: "111.111" }] } } },
      threadId: "222.222",
    },
    { name: "malformed shares", file: { channels: undefined, shares: "invalid" } },
    { name: "non-array shares", file: { channels: undefined, shares: { private: { C123: {} } } } },
    {
      name: "shares without timestamps",
      file: { channels: undefined, shares: { private: { C123: [{}] } } },
    },
    { name: "blank requested channel", file: {}, channelId: "   " },
  ])("rejects $name before downloading", async ({ file, threadId, channelId }) => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({ file: fileInfo(file) });
    await expect(
      download(client, { threadId, channelId: channelId ?? "C123" }),
    ).resolves.toBeNull();
    expect(resolveSlackMedia).not.toHaveBeenCalled();
  });
});
