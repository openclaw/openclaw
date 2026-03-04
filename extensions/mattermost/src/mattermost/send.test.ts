import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageMattermost } from "./send.js";

const mockState = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  loadOutboundMediaFromUrl: vi.fn(),
  resolveMattermostAccount: vi.fn(() => ({
    accountId: "default",
    botToken: "bot-token",
    baseUrl: "https://mattermost.example.com",
  })),
  createMattermostClient: vi.fn(),
  createMattermostDirectChannel: vi.fn(),
  createMattermostPost: vi.fn(),
  fetchMattermostMe: vi.fn(),
  fetchMattermostUserByUsername: vi.fn(),
  normalizeMattermostBaseUrl: vi.fn((input: string | undefined) => input?.trim() ?? ""),
  uploadMattermostFile: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/mattermost", () => ({
  getProtectedDestinationMap: () => new Map(),
  guardWrite: () => true,
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("./accounts.js", () => ({
  resolveMattermostAccount: mockState.resolveMattermostAccount,
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
      loadConfig: mockState.loadConfig,
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
    mockState.loadConfig.mockReset();
    mockState.loadConfig.mockReturnValue({});
    mockState.resolveMattermostAccount.mockReset();
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
    });
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

  it("uses provided cfg and skips runtime loadConfig", async () => {
    const providedCfg = {
      channels: {
        mattermost: {
          botToken: "provided-token",
        },
      },
    };

    await sendMessageMattermost("channel:town-square", "hello", {
      cfg: providedCfg as any,
      accountId: "work",
    });

    expect(mockState.loadConfig).not.toHaveBeenCalled();
    expect(mockState.resolveMattermostAccount).toHaveBeenCalledWith({
      cfg: providedCfg,
      accountId: "work",
    });
  });

  it("falls back to runtime loadConfig when cfg is omitted", async () => {
    const runtimeCfg = {
      channels: {
        mattermost: {
          botToken: "runtime-token",
        },
      },
    };
    mockState.loadConfig.mockReturnValueOnce(runtimeCfg);

    await sendMessageMattermost("channel:town-square", "hello");

    expect(mockState.loadConfig).toHaveBeenCalledTimes(1);
    expect(mockState.resolveMattermostAccount).toHaveBeenCalledWith({
      cfg: runtimeCfg,
      accountId: undefined,
    });
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
