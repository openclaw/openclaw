import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMattermostTarget, sendMessageMattermost } from "./send.js";

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
  fetchMattermostChannelByName: vi.fn(),
  fetchMattermostMe: vi.fn(),
  fetchMattermostUserTeams: vi.fn(),
  fetchMattermostUserByUsername: vi.fn(),
  normalizeMattermostBaseUrl: vi.fn((input: string | undefined) => input?.trim() ?? ""),
  uploadMattermostFile: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/mattermost", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("./accounts.js", () => ({
  resolveMattermostAccount: mockState.resolveMattermostAccount,
}));

vi.mock("./client.js", () => ({
  createMattermostClient: mockState.createMattermostClient,
  createMattermostDirectChannel: mockState.createMattermostDirectChannel,
  createMattermostPost: mockState.createMattermostPost,
  fetchMattermostChannelByName: mockState.fetchMattermostChannelByName,
  fetchMattermostMe: mockState.fetchMattermostMe,
  fetchMattermostUserTeams: mockState.fetchMattermostUserTeams,
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
    mockState.fetchMattermostChannelByName.mockReset();
    mockState.fetchMattermostMe.mockReset();
    mockState.fetchMattermostUserTeams.mockReset();
    mockState.fetchMattermostUserByUsername.mockReset();
    mockState.uploadMattermostFile.mockReset();
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostPost.mockResolvedValue({ id: "post-1" });
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-user" });
    mockState.fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }]);
    mockState.fetchMattermostChannelByName.mockResolvedValue({ id: "town-square" });
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

describe("parseMattermostTarget", () => {
  it("parses channel: prefix with valid ID as channel id", () => {
    const target = parseMattermostTarget("channel:dthcxgoxhifn3pwh65cut3ud3w");
    expect(target).toEqual({ kind: "channel", id: "dthcxgoxhifn3pwh65cut3ud3w" });
  });

  it("parses channel: prefix with non-ID as channel name", () => {
    const target = parseMattermostTarget("channel:abc123");
    expect(target).toEqual({ kind: "channel-name", name: "abc123" });
  });

  it("parses user: prefix as user id", () => {
    const target = parseMattermostTarget("user:usr456");
    expect(target).toEqual({ kind: "user", id: "usr456" });
  });

  it("parses mattermost: prefix as user id", () => {
    const target = parseMattermostTarget("mattermost:usr789");
    expect(target).toEqual({ kind: "user", id: "usr789" });
  });

  it("parses @ prefix as username", () => {
    const target = parseMattermostTarget("@alice");
    expect(target).toEqual({ kind: "user", username: "alice" });
  });

  it("parses # prefix as channel name", () => {
    const target = parseMattermostTarget("#off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("parses # prefix with spaces", () => {
    const target = parseMattermostTarget("  #general  ");
    expect(target).toEqual({ kind: "channel-name", name: "general" });
  });

  it("treats 26-char alphanumeric bare string as channel id", () => {
    const target = parseMattermostTarget("dthcxgoxhifn3pwh65cut3ud3w");
    expect(target).toEqual({ kind: "channel", id: "dthcxgoxhifn3pwh65cut3ud3w" });
  });

  it("treats non-ID bare string as channel name", () => {
    const target = parseMattermostTarget("off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("treats channel: with non-ID value as channel name", () => {
    const target = parseMattermostTarget("channel:off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("throws on empty string", () => {
    expect(() => parseMattermostTarget("")).toThrow("Recipient is required");
  });

  it("throws on empty # prefix", () => {
    expect(() => parseMattermostTarget("#")).toThrow("Channel name is required");
  });

  it("throws on empty @ prefix", () => {
    expect(() => parseMattermostTarget("@")).toThrow("Username is required");
  });

  it("parses channel:#name as channel name", () => {
    const target = parseMattermostTarget("channel:#off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("parses channel:#name with spaces", () => {
    const target = parseMattermostTarget("  channel: #general  ");
    expect(target).toEqual({ kind: "channel-name", name: "general" });
  });

  it("is case-insensitive for prefixes", () => {
    expect(parseMattermostTarget("CHANNEL:dthcxgoxhifn3pwh65cut3ud3w")).toEqual({
      kind: "channel",
      id: "dthcxgoxhifn3pwh65cut3ud3w",
    });
    expect(parseMattermostTarget("User:XYZ")).toEqual({ kind: "user", id: "XYZ" });
    expect(parseMattermostTarget("Mattermost:QRS")).toEqual({ kind: "user", id: "QRS" });
  });
});
