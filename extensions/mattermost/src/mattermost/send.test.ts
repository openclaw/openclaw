import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectProvidedCfgSkipsRuntimeLoad,
  expectRuntimeCfgFallback,
} from "../../../../test/helpers/extensions/send-config.js";
import { parseMattermostTarget, sendMessageMattermost } from "./send.js";
import { resetMattermostOpaqueTargetCacheForTests } from "./target-resolution.js";

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
  fetchMattermostUser: vi.fn(),
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
  fetchMattermostUser: mockState.fetchMattermostUser,
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
    mockState.fetchMattermostUser.mockReset();
    mockState.fetchMattermostUserTeams.mockReset();
    mockState.fetchMattermostUserByUsername.mockReset();
    mockState.uploadMattermostFile.mockReset();
    resetMattermostOpaqueTargetCacheForTests();
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

    expectProvidedCfgSkipsRuntimeLoad({
      loadConfig: mockState.loadConfig,
      resolveAccount: mockState.resolveMattermostAccount,
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

    expectRuntimeCfgFallback({
      loadConfig: mockState.loadConfig,
      resolveAccount: mockState.resolveMattermostAccount,
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

  it("builds interactive button props when buttons are provided", async () => {
    await sendMessageMattermost("channel:town-square", "Pick a model", {
      buttons: [[{ callback_data: "mdlprov", text: "Browse providers" }]],
    });

    expect(mockState.createMattermostPost).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channelId: "town-square",
        message: "Pick a model",
        props: expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({
              actions: expect.arrayContaining([
                expect.objectContaining({
                  id: "mdlprov",
                  name: "Browse providers",
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  it("resolves a bare Mattermost user id as a DM target before upload", async () => {
    const userId = "dthcxgoxhifn3pwh65cut3ud3w";
    mockState.fetchMattermostUser.mockResolvedValueOnce({ id: userId });
    mockState.createMattermostDirectChannel.mockResolvedValueOnce({ id: "dm-channel-1" });
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("media-bytes"),
      fileName: "photo.png",
      contentType: "image/png",
      kind: "image",
    });

    const result = await sendMessageMattermost(userId, "hello", {
      mediaUrl: "file:///tmp/agent-workspace/photo.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.fetchMattermostUser).toHaveBeenCalledWith({}, userId);
    expect(mockState.createMattermostDirectChannel).toHaveBeenCalledWith({}, ["bot-user", userId]);
    expect(mockState.uploadMattermostFile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channelId: "dm-channel-1",
      }),
    );
    expect(result.channelId).toBe("dm-channel-1");
  });

  it("falls back to a channel target when bare Mattermost id is not a user", async () => {
    const channelId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    mockState.fetchMattermostUser.mockRejectedValueOnce(
      new Error("Mattermost API 404 Not Found: user not found"),
    );
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("media-bytes"),
      fileName: "photo.png",
      contentType: "image/png",
      kind: "image",
    });

    const result = await sendMessageMattermost(channelId, "hello", {
      mediaUrl: "file:///tmp/agent-workspace/photo.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.fetchMattermostUser).toHaveBeenCalledWith({}, channelId);
    expect(mockState.createMattermostDirectChannel).not.toHaveBeenCalled();
    expect(mockState.uploadMattermostFile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channelId,
      }),
    );
    expect(result.channelId).toBe(channelId);
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

// Each test uses a unique (token, id) pair to avoid module-level cache collisions.
// userIdResolutionCache and dmChannelCache are module singletons that survive across tests.
// Using unique cache keys per test ensures full isolation without needing a cache reset API.
describe("sendMessageMattermost user-first resolution", () => {
  function makeAccount(token: string) {
    return {
      accountId: "default",
      botToken: token,
      baseUrl: "https://mattermost.example.com",
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostPost.mockResolvedValue({ id: "post-id" });
    mockState.createMattermostDirectChannel.mockResolvedValue({ id: "dm-channel-id" });
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-id" });
  });

  it("resolves unprefixed 26-char id as user and sends via DM channel", async () => {
    // Unique token + id to avoid cache pollution from other tests
    const userId = "aaaaaa1111111111aaaaaa1111"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-user-dm-t1"));
    mockState.fetchMattermostUser.mockResolvedValueOnce({ id: userId });

    const res = await sendMessageMattermost(userId, "hello");

    expect(mockState.fetchMattermostUser).toHaveBeenCalledTimes(1);
    expect(mockState.createMattermostDirectChannel).toHaveBeenCalledTimes(1);
    const params = mockState.createMattermostPost.mock.calls[0]?.[1];
    expect(params.channelId).toBe("dm-channel-id");
    expect(res.channelId).toBe("dm-channel-id");
    expect(res.messageId).toBe("post-id");
  });

  it("falls back to channel id when user lookup returns 404", async () => {
    // Unique token + id for this test
    const channelId = "bbbbbb2222222222bbbbbb2222"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-404-t2"));
    const err = new Error("Mattermost API 404: user not found");
    mockState.fetchMattermostUser.mockRejectedValueOnce(err);

    const res = await sendMessageMattermost(channelId, "hello");

    expect(mockState.fetchMattermostUser).toHaveBeenCalledTimes(1);
    expect(mockState.createMattermostDirectChannel).not.toHaveBeenCalled();
    const params = mockState.createMattermostPost.mock.calls[0]?.[1];
    expect(params.channelId).toBe(channelId);
    expect(res.channelId).toBe(channelId);
  });

  it("falls back to channel id without caching negative result on transient error", async () => {
    // Two unique tokens so each call has its own cache namespace
    const userId = "cccccc3333333333cccccc3333"; // 26 chars
    const tokenA = "token-transient-t3a";
    const tokenB = "token-transient-t3b";
    const transientErr = new Error("Mattermost API 503: service unavailable");

    // First call: transient error → fall back to channel id, do NOT cache negative
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount(tokenA));
    mockState.fetchMattermostUser.mockRejectedValueOnce(transientErr);

    const res1 = await sendMessageMattermost(userId, "first");
    expect(res1.channelId).toBe(userId);

    // Second call with a different token (new cache key) → retries user lookup
    vi.clearAllMocks();
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostPost.mockResolvedValue({ id: "post-id-2" });
    mockState.createMattermostDirectChannel.mockResolvedValue({ id: "dm-channel-id" });
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-id" });
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount(tokenB));
    mockState.fetchMattermostUser.mockResolvedValueOnce({ id: userId });

    const res2 = await sendMessageMattermost(userId, "second");
    expect(mockState.fetchMattermostUser).toHaveBeenCalledTimes(1);
    expect(res2.channelId).toBe("dm-channel-id");
  });

  it("does not apply user-first resolution for explicit user: prefix", async () => {
    // Unique token + id — explicit user: prefix bypasses probe, goes straight to DM
    const userId = "dddddd4444444444dddddd4444"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-explicit-user-t4"));

    const res = await sendMessageMattermost(`user:${userId}`, "hello");

    expect(mockState.fetchMattermostUser).not.toHaveBeenCalled();
    expect(mockState.createMattermostDirectChannel).toHaveBeenCalledTimes(1);
    expect(res.channelId).toBe("dm-channel-id");
  });

  it("does not apply user-first resolution for explicit channel: prefix", async () => {
    // Unique token + id — explicit channel: prefix, no probe, no DM
    const chanId = "eeeeee5555555555eeeeee5555"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-explicit-chan-t5"));

    const res = await sendMessageMattermost(`channel:${chanId}`, "hello");

    expect(mockState.fetchMattermostUser).not.toHaveBeenCalled();
    expect(mockState.createMattermostDirectChannel).not.toHaveBeenCalled();
    const params = mockState.createMattermostPost.mock.calls[0]?.[1];
    expect(params.channelId).toBe(chanId);
    expect(res.channelId).toBe(chanId);
  });
});
