import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let sendMessageMattermost: typeof import("./send.js").sendMessageMattermost;
let parseMattermostTarget: typeof import("./target-resolution.js").parseMattermostTarget;

const TEST_CFG = {};

const mockState = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  loadOutboundMediaFromUrl: vi.fn(),
  recordActivity: vi.fn(),
  resolveMattermostAccount: vi.fn(() => ({
    accountId: "default",
    botToken: "bot-token",
    baseUrl: "https://mattermost.example.com",
    config: {},
  })),
  createMattermostClient: vi.fn(),
  createMattermostDirectChannelWithRetry: vi.fn(),
  createMattermostPost: vi.fn(),
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
  uploadMattermostFile: vi.fn(),
}));

type MattermostPostParams = {
  channelId?: string;
  message?: string;
  props?: {
    attachments?: Array<{
      actions?: Array<{ id?: string; name?: string }>;
    }>;
  };
};

type MattermostUploadParams = {
  channelId?: string;
  fileName?: string;
  contentType?: string;
};

type DmRetryOptions = import("./client.js").CreateDmChannelRetryOptions;

function mockCall(mock: unknown, label: string, index = 0): unknown[] {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  const call = calls?.at(index);
  if (!call) {
    throw new Error(`Expected ${label} call ${index + 1}`);
  }
  return call;
}

function uploadMattermostFileCall() {
  return mockCall(mockState.uploadMattermostFile, "uploadMattermostFile") as [
    unknown,
    MattermostUploadParams?,
  ];
}

function createMattermostPostParams() {
  const params = mockCall(mockState.createMattermostPost, "createMattermostPost")[1] as
    | MattermostPostParams
    | undefined;
  if (!params) {
    throw new Error("Expected createMattermostPost params");
  }
  return params;
}

function createMattermostPostCall() {
  return mockCall(mockState.createMattermostPost, "createMattermostPost") as [
    unknown,
    MattermostPostParams?,
  ];
}

function directChannelRetryCall() {
  return mockCall(
    mockState.createMattermostDirectChannelWithRetry,
    "createMattermostDirectChannelWithRetry",
  ) as [unknown, unknown, DmRetryOptions?];
}

async function createMattermostProviderFailure(
  status: number,
  statusText: string,
  message: string,
): Promise<Error> {
  const { createMattermostClient } =
    await vi.importActual<typeof import("./client.js")>("./client.js");
  const client = createMattermostClient({
    baseUrl: "https://mattermost.example.com",
    botToken: "test-bot-token",
    fetchImpl: async () =>
      new Response(JSON.stringify({ message }), {
        status,
        statusText,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    await client.request("/teams/team-first/channels/name/release-alerts");
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the Mattermost provider request to fail");
}

vi.mock("../../runtime-api.js", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("./runtime-api.js", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: (cfg: unknown) => {
    if (cfg) {
      return cfg;
    }
    throw new Error("Mattermost send requires a resolved runtime config");
  },
}));

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", () => ({
  resolveMarkdownTableMode: mockState.resolveMarkdownTableMode,
}));

vi.mock("openclaw/plugin-sdk/string-coerce-runtime", () => ({
  normalizeLowercaseStringOrEmpty: vi.fn((value: string | null | undefined) => {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim().toLowerCase();
  }),
  normalizeOptionalString: vi.fn((value: string | null | undefined) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }),
  normalizeStringifiedOptionalString: vi.fn((value: unknown) => {
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : undefined;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      const normalized = String(value).trim();
      return normalized.length > 0 ? normalized : undefined;
    }
    return undefined;
  }),
}));

vi.mock("./accounts.js", () => ({
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

vi.mock("../runtime.js", () => {
  const getMattermostRuntime = () => ({
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
        record: mockState.recordActivity,
      },
    },
  });
  return { getMattermostRuntime, getOptionalMattermostRuntime: getMattermostRuntime };
});

beforeAll(async () => {
  ({ sendMessageMattermost } = await import("./send.js"));
  ({ parseMattermostTarget } = await import("./target-resolution.js"));
});

describe("sendMessageMattermost", () => {
  let defaultAccountSequence = 0;

  beforeEach(() => {
    mockState.loadConfig.mockReset();
    mockState.loadConfig.mockReturnValue({});
    mockState.recordActivity.mockReset();
    mockState.resolveMattermostAccount.mockReset();
    // Production caches are keyed by token; keep each test in its own real namespace.
    const cacheNamespace = `mattermost-cache-${defaultAccountSequence++}`;
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: cacheNamespace,
      baseUrl: "https://mattermost.example.com",
      config: {},
    });
    mockState.loadOutboundMediaFromUrl.mockReset();
    mockState.createMattermostClient.mockReset();
    mockState.createMattermostDirectChannelWithRetry.mockReset();
    mockState.createMattermostPost.mockReset();
    mockState.fetchMattermostChannelByName.mockReset();
    mockState.fetchMattermostMe.mockReset();
    mockState.fetchMattermostUser.mockReset();
    mockState.fetchMattermostUserTeams.mockReset();
    mockState.fetchMattermostUserByUsername.mockReset();
    mockState.resolveMarkdownTableMode.mockClear();
    mockState.uploadMattermostFile.mockReset();
    mockState.createMattermostClient.mockImplementation(({ baseUrl: clientBaseUrl, botToken }) => ({
      baseUrl: clientBaseUrl,
      token: botToken,
    }));
    mockState.createMattermostPost.mockResolvedValue({ id: "post-1" });
    mockState.createMattermostDirectChannelWithRetry.mockResolvedValue({ id: "dm-channel-1" });
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-user" });
    mockState.fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }]);
    mockState.fetchMattermostChannelByName.mockResolvedValue({ id: "town-square" });
    mockState.uploadMattermostFile.mockResolvedValue({ id: "file-1" });
  });

  it("reports a missing named channel after every team returns not found", async () => {
    mockState.fetchMattermostUserTeams.mockResolvedValueOnce([
      { id: "team-first" },
      { id: "team-second" },
    ]);
    mockState.fetchMattermostChannelByName.mockRejectedValue(
      await createMattermostProviderFailure(404, "Not Found", "missing channel"),
    );

    await expect(
      sendMessageMattermost("#release-alerts", "hello", { cfg: TEST_CFG }),
    ).rejects.toThrow('Mattermost channel "#release-alerts" not found in any team');

    expect(mockState.fetchMattermostChannelByName).toHaveBeenCalledTimes(2);
    expect(mockState.createMattermostPost).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an outage whose detail mentions a missing resource",
      createError: () =>
        createMattermostProviderFailure(503, "Service Unavailable", "upstream returned 404"),
    },
  ])("preserves $name while resolving a named channel", async ({ createError }) => {
    const error = await createError();
    mockState.fetchMattermostUserTeams.mockResolvedValueOnce([
      { id: "team-first" },
      { id: "team-second" },
    ]);
    mockState.fetchMattermostChannelByName
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ id: "channel-second" });

    await expect(sendMessageMattermost("#release-alerts", "hello", { cfg: TEST_CFG })).rejects.toBe(
      error,
    );

    expect(mockState.fetchMattermostChannelByName).toHaveBeenCalledOnce();
    expect(mockState.createMattermostPost).not.toHaveBeenCalled();
  });

  it("fails hard when cfg is omitted", async () => {
    await expect(
      sendMessageMattermost("channel:town-square", "hello", undefined as never),
    ).rejects.toThrow("Mattermost send requires a resolved runtime config");
    expect(mockState.loadConfig).not.toHaveBeenCalled();
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

    let caught: unknown;
    try {
      await sendMessageMattermost("channel:town-square", "requested text", {
        cfg: TEST_CFG,
        onDeliveryResult,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial Mattermost delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["post-final"],
      visibleReplySent: true,
      content: "provider-final",
    });
    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "post-final",
        channelId: "town-square",
        content: "provider-final",
      }),
    );
    expect(events).toStrictEqual(["delivery", "activity"]);
  });

  it("builds interactive button props when buttons are provided", async () => {
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });

    await sendMessageMattermost("channel:town-square", "Pick a model", {
      cfg: TEST_CFG,
      buttons: [[{ callback_data: "mdlprov", text: "Browse providers" }]],
    });

    const postCall = createMattermostPostCall();
    expect(postCall?.[0]).toEqual(
      expect.objectContaining({ baseUrl: "https://mattermost.example.com" }),
    );
    expect(postCall?.[1]?.channelId).toBe("town-square");
    expect(postCall?.[1]?.message).toBe("Pick a model");
    const attachments = postCall?.[1]?.props?.attachments;
    expect(Array.isArray(attachments)).toBe(true);
    const actions = attachments?.[0]?.actions;
    expect(Array.isArray(actions)).toBe(true);
    expect(actions?.[0]?.id).toBe("mdlprov");
    expect(actions?.[0]?.name).toBe("Browse providers");
  });

  it("falls back to a channel target when bare Mattermost id is not a user", async () => {
    const channelId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });
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
    const uploadCall = uploadMattermostFileCall();
    expect(uploadCall?.[0]).toEqual(
      expect.objectContaining({ baseUrl: "https://mattermost.example.com" }),
    );
    expect(uploadCall?.[1]?.channelId).toBe(channelId);
    expect(result.channelId).toBe(channelId);
  });
});

describe("parseMattermostTarget", () => {
  it("throws on empty string", () => {
    expect(() => parseMattermostTarget("")).toThrow("Recipient is required");
  });

  it("throws on empty # prefix", () => {
    expect(() => parseMattermostTarget("#")).toThrow("Channel name is required");
  });

  it("throws on empty @ prefix", () => {
    expect(() => parseMattermostTarget("@")).toThrow("Username is required");
  });

  it("parses channel:#name with spaces", () => {
    const target = parseMattermostTarget("  channel: #general  ");
    expect(target).toEqual({ kind: "channel-name", name: "general" });
  });
});

describe("sendMessageMattermost user-first resolution", () => {
  function makeAccount(token: string, config = {}) {
    return {
      accountId: "default",
      botToken: token,
      baseUrl: "https://mattermost.example.com",
      config,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.createMattermostClient.mockImplementation(({ baseUrl: clientBaseUrl, botToken }) => ({
      baseUrl: clientBaseUrl,
      token: botToken,
    }));
    mockState.createMattermostPost.mockResolvedValue({ id: "post-id" });
    mockState.createMattermostDirectChannelWithRetry.mockResolvedValue({ id: "dm-channel-id" });
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-id" });
  });

  it("captures retry settings before resolving a bare user id and sends via DM", async () => {
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
      base.maxRetries = 9;
      base.timeoutMs = 1;
      expect(mockState.createMattermostDirectChannelWithRetry).not.toHaveBeenCalled();
      release.resolve({ id: userId });
      const result = await sending;
      expect(mockState.fetchMattermostUser).toHaveBeenCalledTimes(1);
      expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledTimes(1);
      const retry = directChannelRetryCall();
      expect(retry[1]).toEqual(["bot-id", userId]);
      expect(retry[2]).toStrictEqual({
        maxRetries: 2,
        initialDelayMs: 1000,
        maxDelayMs: undefined,
        timeoutMs: 20000,
        onRetry: expect.any(Function),
      });
      expect(mockState.fetchMattermostUser.mock.invocationCallOrder[0]).toBeLessThan(
        mockState.createMattermostDirectChannelWithRetry.mock.invocationCallOrder[0]!,
      );
      expect(
        mockState.createMattermostDirectChannelWithRetry.mock.invocationCallOrder[0],
      ).toBeLessThan(mockState.createMattermostPost.mock.invocationCallOrder[0]!);
      expect(createMattermostPostParams()).toMatchObject({
        channelId: "dm-channel-id",
        message: "captured",
      });
      expect(result).toMatchObject({ channelId: "dm-channel-id", messageId: "post-id" });
      expect(result.receipt).toMatchObject({
        primaryPlatformMessageId: "post-id",
        platformMessageIds: ["post-id"],
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
    vi.clearAllMocks();
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "default-token",
      baseUrl,
      config: {},
    });
    mockState.createMattermostClient.mockImplementation(({ baseUrl: clientBaseUrl, botToken }) => ({
      baseUrl: clientBaseUrl,
      token: botToken,
    }));
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

  it("bounds username entries and retains the newest resolved target", async () => {
    const token = "username-cache-token";
    for (let index = 0; index < 1024; index += 1) {
      await send(`@name-${index}`, token);
    }
    await send("@name-0", token);
    await send("@name-1024", token);
    await send("@name-0", token);
    await send("@name-1024", token);

    expect(mockState.fetchMattermostUserByUsername).toHaveBeenCalledTimes(1026);
    expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledTimes(1026);
  });

  it("bounds channel-name entries and retains the newest resolved target", async () => {
    const token = "channel-cache-token";
    for (let index = 0; index < 1024; index += 1) {
      await send(`#channel-${index}`, token);
    }
    await send("#channel-0", token);
    await send("#channel-1024", token);
    await send("#channel-0", token);
    await send("#channel-1024", token);

    expect(mockState.fetchMattermostChannelByName).toHaveBeenCalledTimes(1026);
  });

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
