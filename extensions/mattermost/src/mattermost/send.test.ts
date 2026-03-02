import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageMattermost } from "./send.js";

const mockState = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  createMattermostClient: vi.fn(),
  createMattermostDirectChannel: vi.fn(),
  createMattermostPost: vi.fn(),
  fetchMattermostMe: vi.fn(),
  fetchMattermostUserByUsername: vi.fn(),
  normalizeMattermostBaseUrl: vi.fn((input: string | undefined) => input?.trim() ?? ""),
  uploadMattermostFile: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("./accounts.js", () => ({
  resolveMattermostAccount: () => ({
    accountId: "default",
    botToken: "bot-token",
    baseUrl: "https://mattermost.example.com",
  }),
}));

vi.mock("./client.js", () => ({
  createMattermostClient: mockState.createMattermostClient,
  createMattermostDirectChannel: mockState.createMattermostDirectChannel,
  createMattermostPost: mockState.createMattermostPost,
  fetchMattermostMe: mockState.fetchMattermostMe,
  fetchMattermostUserByUsername: mockState.fetchMattermostUserByUsername,
  normalizeMattermostBaseUrl: mockState.normalizeMattermostBaseUrl,
  uploadMattermostFile: mockState.uploadMattermostFile,
}));

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => ({
    config: {
      loadConfig: () => ({}),
    },
    logging: {
      shouldLogVerbose: () => false,
      getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "off",
        convertMarkdownTables: (text: string) => text,
      },
      activity: {
        record: vi.fn(),
      },
    },
  }),
}));

describe("sendMessageMattermost", () => {
  beforeEach(() => {
    mockState.loadOutboundMediaFromUrl.mockReset();
    mockState.createMattermostClient.mockReset();
    mockState.createMattermostDirectChannel.mockReset();
    mockState.createMattermostPost.mockReset();
    mockState.fetchMattermostMe.mockReset();
    mockState.fetchMattermostUserByUsername.mockReset();
    mockState.uploadMattermostFile.mockReset();
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostPost.mockResolvedValue({ id: "post-1" });
    mockState.uploadMattermostFile.mockResolvedValue({ id: "file-1" });
  });

  it("loads outbound media with trusted local roots before upload", async () => {
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("media-bytes"),
      fileName: "photo.png",
      contentType: "image/png",
      kind: "image",
    });

    await sendMessageMattermost("channel:town-square", "hello", {
      mediaUrl: "file:///tmp/agent-workspace/photo.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "file:///tmp/agent-workspace/photo.png",
      {
        mediaLocalRoots: ["/tmp/agent-workspace"],
      },
    );
    expect(mockState.uploadMattermostFile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channelId: "town-square",
        fileName: "photo.png",
        contentType: "image/png",
      }),
    );
  });
});
