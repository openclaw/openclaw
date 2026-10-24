import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";

let sendMessageMattermost: typeof import("./send.js").sendMessageMattermost;
let parseMattermostTarget: typeof import("./target-resolution.js").parseMattermostTarget;

const TEST_CFG = {};
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const mockState = vi.hoisted(() => ({
  currentConfig: vi.fn(() => ({})),
  loadOutboundMediaFromUrl: vi.fn(),
  recordActivity: vi.fn(),
  resolveMattermostAccount: vi.fn(() => ({
    accountId: "default",
    botToken: "bot-token",
    baseUrl: "https://mattermost.example.com",
    config: {},
  })),
  createMattermostClient: vi.fn(),
  createMattermostDirectChannelWithRetry:
    vi.fn<typeof import("./client.js").createMattermostDirectChannelWithRetry>(),
  createMattermostPost: vi.fn<typeof import("./client.js").createMattermostPost>(),
  fetchMattermostChannelByName: vi.fn(),
  fetchMattermostMe: vi.fn(),
  fetchMattermostUser: vi.fn(),
  fetchMattermostUserTeams: vi.fn(),
  fetchMattermostUserByUsername: vi.fn(),
  normalizeMattermostBaseUrl: vi.fn((input: string | undefined) => input?.trim() ?? ""),
  resolveMarkdownTableMode: vi.fn(
    (params: { cfg?: { channels?: { mattermost?: { markdown?: { tables?: string } } } } }) =>
      params.cfg?.channels?.mattermost?.markdown?.tables ?? "off",
  ),
  uploadMattermostFile: vi.fn<typeof import("./client.js").uploadMattermostFile>(),
}));

function makeAccount(botToken: string, config = {}) {
  return { accountId: "default", botToken, baseUrl: "https://mattermost.example.com", config };
}

async function createMattermostProviderFailure(
  status: number,
  statusText: string,
  message: string,
): Promise<Error> {
  const { createMattermostClient } =
    await vi.importActual<typeof import("./client.js")>("./client.js");
  fetchWithSsrFGuardMock.mockImplementationOnce(
    async (
      params: Parameters<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>[0],
    ) => {
      params.beforeRequest?.();
      return {
        response: new Response(JSON.stringify({ message }), {
          status,
          statusText,
          headers: { "content-type": "application/json" },
        }),
        release: async () => {},
      };
    },
  );
  const client = createMattermostClient({
    baseUrl: "https://mattermost.example.com",
    botToken: "test-bot-token",
  });
  const error: unknown = await client
    .request("/teams/team-first/channels/name/release-alerts")
    .catch((failure: unknown) => failure);
  if (error instanceof Error) {
    return error;
  }
  throw new Error("Expected the Mattermost provider request to fail");
}

vi.mock("../../runtime-api.js", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("./runtime-api.js", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", () => ({
  resolveMarkdownTableMode: mockState.resolveMarkdownTableMode,
}));

vi.mock("./accounts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accounts.js")>()),
  resolveMattermostAccount: mockState.resolveMattermostAccount,
}));

vi.mock("./client.js", async () => ({
  parseMattermostApiStatus: (await vi.importActual<typeof import("./client.js")>("./client.js"))
    .parseMattermostApiStatus,
  createMattermostClient: mockState.createMattermostClient,
  createMattermostDirectChannelWithRetry: mockState.createMattermostDirectChannelWithRetry,
  createMattermostPost: mockState.createMattermostPost,
  fetchMattermostChannelByName: mockState.fetchMattermostChannelByName,
  fetchMattermostMe: mockState.fetchMattermostMe,
  fetchMattermostUser: mockState.fetchMattermostUser,
  fetchMattermostUserTeams: mockState.fetchMattermostUserTeams,
  fetchMattermostUserByUsername: mockState.fetchMattermostUserByUsername,
  normalizeMattermostBaseUrl: mockState.normalizeMattermostBaseUrl,
  uploadMattermostFile: mockState.uploadMattermostFile,
}));

beforeAll(async () => {
  ({ sendMessageMattermost } = await import("./send.js"));
  ({ parseMattermostTarget } = await import("./target-resolution.js"));
});

const normalizeBaseUrl = mockState.normalizeMattermostBaseUrl.getMockImplementation()!;
const resolveTableMode = mockState.resolveMarkdownTableMode.getMockImplementation()!;
let defaultAccountSequence = 0;

beforeEach(() => {
  vi.resetAllMocks();
  setMattermostRuntime(
    createPluginRuntimeMock({
      config: { current: mockState.currentConfig },
      channel: { activity: { record: mockState.recordActivity } },
    }),
  );
  mockState.normalizeMattermostBaseUrl.mockImplementation(normalizeBaseUrl);
  mockState.resolveMarkdownTableMode.mockImplementation(resolveTableMode);
  mockState.currentConfig.mockReturnValue({});
  mockState.resolveMattermostAccount.mockReturnValue(
    makeAccount("mattermost-cache-" + defaultAccountSequence++),
  );
  mockState.createMattermostClient.mockImplementation(({ baseUrl, botToken }) => ({
    baseUrl,
    token: botToken,
  }));
  mockState.createMattermostPost.mockResolvedValue({ id: "post-1" });
  mockState.createMattermostDirectChannelWithRetry.mockResolvedValue({ id: "dm-channel-1" });
  mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-user" });
  mockState.fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }]);
  mockState.fetchMattermostChannelByName.mockResolvedValue({ id: "town-square" });
  mockState.uploadMattermostFile.mockResolvedValue({ id: "file-1" });
});

describe("sendMessageMattermost", () => {
  it.each<[number, string, string]>([
    [404, "Not Found", "missing channel"],
    [503, "Service Unavailable", "upstream returned 404"],
  ])("preserves named-channel resolution failure %s", async (status, statusText, message) => {
    const error = await createMattermostProviderFailure(status, statusText, message);
    mockState.fetchMattermostUserTeams.mockResolvedValueOnce([
      { id: "team-first" },
      { id: "team-second" },
    ]);
    mockState.fetchMattermostChannelByName.mockRejectedValue(error);
    const sending = sendMessageMattermost("#release-alerts", "hello", { cfg: TEST_CFG });
    if (status === 404) {
      await expect(sending).rejects.toThrow(
        'Mattermost channel "#release-alerts" not found in any team',
      );
    } else {
      await expect(sending).rejects.toBe(error);
    }
    expect(mockState.fetchMattermostChannelByName).toHaveBeenCalledTimes(status === 404 ? 2 : 1);
    expect(mockState.createMattermostPost).not.toHaveBeenCalled();
  });

  it("fails hard when cfg is omitted", async () => {
    await expect(
      sendMessageMattermost("channel:town-square", "hello", undefined as never),
    ).rejects.toThrow("Mattermost send requires a resolved runtime config");
    expect(mockState.currentConfig).not.toHaveBeenCalled();
    expect(mockState.resolveMattermostAccount).not.toHaveBeenCalled();
  });

  it("preserves the provider post when outbound bookkeeping fails afterward", async () => {
    const events: string[] = [];
    const onDeliveryResult = vi.fn(() => {
      events.push("delivery");
    });
    mockState.createMattermostPost.mockResolvedValueOnce({
      id: "post-final",
      message: "provider-final",
    });
    mockState.recordActivity.mockImplementationOnce(() => {
      events.push("activity");
      throw new Error("activity store unavailable");
    });

    const caught: unknown = await sendMessageMattermost("channel:town-square", "requested text", {
      cfg: TEST_CFG,
      onDeliveryResult,
    }).catch((error: unknown) => error);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial Mattermost delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["post-final"],
      visibleReplySent: true,
      content: "provider-final",
    });
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        messageId: "post-final",
        channelId: "town-square",
        content: "provider-final",
      }),
    );
    expect(events).toStrictEqual(["delivery", "activity"]);
  });

  it("builds interactive button props when buttons are provided", async () => {
    mockState.resolveMattermostAccount.mockReturnValue(
      makeAccount("bot-token", {
        interactions: { callbackBaseUrl: "https://callbacks.example.test/" },
      }),
    );

    await sendMessageMattermost("channel:town-square", "Pick a model", {
      cfg: TEST_CFG,
      buttons: [[{ callback_data: "mdlprov", text: "Browse providers" }]],
    });

    const postCall = mockState.createMattermostPost.mock.calls[0]!;
    expect(postCall).toMatchObject([
      { baseUrl: "https://mattermost.example.com" },
      {
        channelId: "town-square",
        message: "Pick a model",
        props: {
          attachments: [
            {
              actions: [
                {
                  id: "mdlprov",
                  name: "Browse providers",
                  integration: {
                    url: "https://callbacks.example.test/mattermost/interactions/default",
                  },
                },
              ],
            },
          ],
        },
      },
    ]);
    expect(mockState.resolveMattermostAccount).toHaveBeenCalledTimes(1);
  });

  it("falls back to a channel target when bare Mattermost id is not a user", async () => {
    const channelId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("bot-token"));
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
      cfg: TEST_CFG,
      mediaUrl: "file:///tmp/agent-workspace/photo.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.fetchMattermostUser).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://mattermost.example.com" }),
      channelId,
    );
    expect(mockState.createMattermostDirectChannelWithRetry).not.toHaveBeenCalled();
    expect(mockState.uploadMattermostFile.mock.calls[0]).toMatchObject([
      { baseUrl: "https://mattermost.example.com" },
      { channelId },
    ]);
    expect(result.channelId).toBe(channelId);
  });
});

describe("parseMattermostTarget", () => {
  it.each<[string, string]>([
    ["", "Recipient is required"],
    ["#", "Channel name is required"],
    ["@", "Username is required"],
  ])("rejects empty target %j", (target, error) => {
    expect(() => parseMattermostTarget(target)).toThrow(error);
  });
  it("parses channel:#name with spaces", () => {
    expect(parseMattermostTarget("  channel: #general  ")).toEqual({
      kind: "channel-name",
      name: "general",
    });
  });
});

describe("sendMessageMattermost user-first resolution", () => {
  beforeEach(() => {
    mockState.createMattermostPost.mockResolvedValue({ id: "post-id" });
    mockState.createMattermostDirectChannelWithRetry.mockResolvedValue({ id: "dm-channel-id" });
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-id" });
  });

  it("forwards retry settings when resolving a bare user id and sends via DM", async () => {
    const userId = "iiiiii9999999999iiiiii9999";
    const entered = createDeferred<void>();
    const release = createDeferred<{ id: string }>();
    const base = { maxRetries: 2, initialDelayMs: 1000, timeoutMs: 20000 };
    mockState.resolveMattermostAccount.mockReturnValue(
      makeAccount("token-retry-capture", { dmChannelRetry: base }),
    );
    mockState.fetchMattermostUser.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const sending = sendMessageMattermost(userId, "captured", {
      cfg: TEST_CFG,
    });
    try {
      await entered.promise;
      expect(mockState.createMattermostDirectChannelWithRetry).not.toHaveBeenCalled();
      release.resolve({ id: userId });
      const result = await sending;
      expect(mockState.fetchMattermostUser).toHaveBeenCalledTimes(1);
      expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledTimes(1);
      const retry = mockState.createMattermostDirectChannelWithRetry.mock.calls[0]!;
      expect(retry[1]).toEqual(["bot-id", userId]);
      expect(retry[2]).toStrictEqual({ ...base, onRetry: expect.any(Function) });
      expect(mockState.fetchMattermostUser.mock.invocationCallOrder[0]).toBeLessThan(
        mockState.createMattermostDirectChannelWithRetry.mock.invocationCallOrder[0]!,
      );
      expect(
        mockState.createMattermostDirectChannelWithRetry.mock.invocationCallOrder[0],
      ).toBeLessThan(mockState.createMattermostPost.mock.invocationCallOrder[0]!);
      expect(mockState.createMattermostPost.mock.calls[0]?.[1]).toMatchObject({
        channelId: "dm-channel-id",
        message: "captured",
      });
      expect(result).toMatchObject({
        channelId: "dm-channel-id",
        messageId: "post-id",
        receipt: { primaryPlatformMessageId: "post-id", platformMessageIds: ["post-id"] },
      });
    } finally {
      release.resolve({ id: userId });
      await sending;
    }
  });
});

describe("sendMessageMattermost outbound cache bounds", () => {
  const baseUrl = "https://mattermost.example.com";

  beforeEach(() => {
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("default-token"));
    mockState.createMattermostPost.mockResolvedValue({ id: "post-id" });
    mockState.createMattermostDirectChannelWithRetry.mockImplementation(
      async (_client, userIds: string[]) => ({ id: `dm-${userIds[1]}` }),
    );
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-id" });
    mockState.fetchMattermostUserByUsername.mockImplementation(
      async (_client, username: string) => ({
        id: `user-${username}`,
      }),
    );
    mockState.fetchMattermostUserTeams.mockResolvedValue([{ id: "team-id" }]);
    mockState.fetchMattermostChannelByName.mockImplementation(
      async (_client, _teamId: string, name: string) => ({ id: `channel-${name}` }),
    );
  });

  const send = async (to: string, token: string) =>
    await sendMessageMattermost(to, "hello", {
      cfg: TEST_CFG,
      botToken: token,
      baseUrl,
    });

  it.each(["username", "channel-name"])(
    "bounds %s entries and retains the newest target",
    async (kind) => {
      const username = kind === "username";
      const token = username ? "username-cache-token" : "channel-cache-token";
      const target = (index: number) => (username ? `@name-${index}` : `#channel-${index}`);
      for (let index = 0; index < 1024; index += 1) {
        await send(target(index), token);
      }
      await send(target(0), token);
      await send(target(1024), token);
      await send(target(0), token);
      await send(target(1024), token);
      expect(
        username ? mockState.fetchMattermostUserByUsername : mockState.fetchMattermostChannelByName,
      ).toHaveBeenCalledTimes(1026);
      if (username) {
        expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledTimes(1026);
      }
    },
  );

  it("bounds bot-user entries independently from DM channel entries", async () => {
    for (let index = 0; index < 64; index += 1) {
      await send(`user:user-${index}`, `bot-cache-token-${index}`);
    }
    await send("user:probe-before-overflow", "bot-cache-token-0");
    await send("user:user-64", "bot-cache-token-64");
    await send("user:probe-after-overflow", "bot-cache-token-0");
    await send("user:newest-probe", "bot-cache-token-64");

    expect(mockState.fetchMattermostMe).toHaveBeenCalledTimes(66);
  });
});
