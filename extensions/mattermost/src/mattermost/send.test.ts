import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
// Mattermost tests cover send plugin behavior.
import { expectProvidedCfgSkipsRuntimeLoad } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let sendMessageMattermost: typeof import("./send.js").sendMessageMattermost;
let parseMattermostTarget: typeof import("./target-resolution.js").parseMattermostTarget;

type SendMessageMattermostOptions = NonNullable<
  Parameters<typeof import("./send.js").sendMessageMattermost>[2]
>;

const TEST_CFG = {};
const MATTERMOST_TABLE_GOLDEN = {
  name: "keeps native Mattermost tables instead of downgrading them to code",
  input: "| A | B |\n|---|---|\n| 1 | 2 |",
  before: "```\n| A   | B   |\n| --- | --- |\n| 1   | 2   |\n```",
  after: "| A | B |\n|---|---|\n| 1 | 2 |",
};
const MATTERMOST_MARKDOWN_GOLDENS = [MATTERMOST_TABLE_GOLDEN];

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

type DmRetryOptions = NonNullable<SendMessageMattermostOptions["dmRetryOptions"]>;

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
        record: mockState.recordActivity,
      },
    },
  }),
}));

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

  it("uses provided cfg and skips runtime loadConfig", async () => {
    const providedCfg = {
      channels: {
        mattermost: {
          botToken: "provided-token",
        },
      },
    };
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "work",
      botToken: "provided-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });

    const options: SendMessageMattermostOptions = {
      cfg: providedCfg,
      accountId: "work",
    };

    await sendMessageMattermost("channel:town-square", "hello", {
      ...options,
    });

    expectProvidedCfgSkipsRuntimeLoad({
      loadConfig: mockState.loadConfig,
      resolveAccount: mockState.resolveMattermostAccount,
      cfg: providedCfg,
      accountId: "work",
    });
  });

  it("continues searching later teams only when a channel is genuinely absent", async () => {
    mockState.fetchMattermostUserTeams.mockResolvedValueOnce([
      { id: "team-first" },
      { id: "team-second" },
    ]);
    mockState.fetchMattermostChannelByName
      .mockRejectedValueOnce(await createMattermostProviderFailure(404, "Not Found", "missing"))
      .mockResolvedValueOnce({ id: "channel-second" });

    const result = await sendMessageMattermost("#release-alerts", "hello", { cfg: TEST_CFG });

    expect(result.channelId).toBe("channel-second");
    expect(mockState.fetchMattermostChannelByName).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ baseUrl: "https://mattermost.example.com" }),
      "team-first",
      "release-alerts",
    );
    expect(mockState.fetchMattermostChannelByName).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ baseUrl: "https://mattermost.example.com" }),
      "team-second",
      "release-alerts",
    );
    expect(mockState.createMattermostPost).toHaveBeenCalledOnce();
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
      name: "an expired bot token",
      createError: () => createMattermostProviderFailure(401, "Unauthorized", "bot token expired"),
    },
    {
      name: "missing channel permissions",
      createError: () => createMattermostProviderFailure(403, "Forbidden", "access denied"),
    },
    {
      name: "provider rate limiting",
      createError: () => createMattermostProviderFailure(429, "Too Many Requests", "retry later"),
    },
    {
      name: "an outage whose detail mentions a missing resource",
      createError: () =>
        createMattermostProviderFailure(503, "Service Unavailable", "upstream returned 404"),
    },
    {
      name: "a network failure",
      createError: async () => new Error("connect ECONNRESET 192.0.2.12:443"),
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

  it.each(MATTERMOST_MARKDOWN_GOLDENS)("$name", async ({ input, before, after }) => {
    expect(convertMarkdownTables(input, "code")).toBe(before);

    await sendMessageMattermost("channel:town-square", input, { cfg: TEST_CFG });

    expect(createMattermostPostParams().message).toBe(after);
  });

  it.each(["code", "block"] as const)(
    "respects the explicit Mattermost %s table fallback mode",
    async (tables) => {
      await sendMessageMattermost("channel:town-square", MATTERMOST_TABLE_GOLDEN.input, {
        cfg: { channels: { mattermost: { markdown: { tables } } } },
      });

      expect(createMattermostPostParams().message).toBe(MATTERMOST_TABLE_GOLDEN.before);
    },
  );

  it("fails hard when cfg is omitted", async () => {
    await expect(
      sendMessageMattermost("channel:town-square", "hello", undefined as never),
    ).rejects.toThrow("Mattermost send requires a resolved runtime config");
    expect(mockState.loadConfig).not.toHaveBeenCalled();
    expect(mockState.resolveMattermostAccount).not.toHaveBeenCalled();
  });

  it("sends with provided cfg even when the runtime store is not initialized", async () => {
    const providedCfg = {
      channels: {
        mattermost: {
          botToken: "provided-token",
        },
      },
    };
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "work",
      botToken: "provided-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });
    mockState.recordActivity.mockImplementation(() => {
      throw new Error("Mattermost runtime not initialized");
    });

    const result = await sendMessageMattermost("channel:town-square", "hello", {
      cfg: providedCfg,
      accountId: "work",
    });

    expect(result.messageId).toBe("post-1");
    expect(result.channelId).toBe("town-square");
    expect(result.receipt.primaryPlatformMessageId).toBe("post-1");
    expect(result.receipt.platformMessageIds).toEqual(["post-1"]);
    expect(result.receipt.parts).toHaveLength(1);
    expect(result.receipt.parts[0]?.platformMessageId).toBe("post-1");
    expect(result.receipt.parts[0]?.kind).toBe("text");
    expect(result.content).toBe("hello");
    expect(mockState.loadConfig).not.toHaveBeenCalled();
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

  it("preserves the provider post when delivery reporting fails afterward", async () => {
    const onDeliveryResult = vi.fn(async () => {
      throw new Error("delivery store unavailable");
    });
    mockState.createMattermostPost.mockResolvedValueOnce({
      id: "post-final",
      message: "provider-final",
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
    expect(mockState.recordActivity).not.toHaveBeenCalled();
  });

  it("loads outbound media with trusted local roots before upload", async () => {
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("media-bytes"),
      fileName: "photo.png",
      contentType: "image/png",
      kind: "image",
    });
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });

    await sendMessageMattermost("channel:town-square", "hello", {
      cfg: TEST_CFG,
      mediaUrl: "file:///tmp/agent-workspace/photo.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
      workspaceDir: "/tmp/agent-workspace",
    });

    expect(mockState.loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "file:///tmp/agent-workspace/photo.png",
      {
        mediaLocalRoots: ["/tmp/agent-workspace"],
        workspaceDir: "/tmp/agent-workspace",
      },
    );
    const uploadCall = uploadMattermostFileCall();
    expect(uploadCall?.[0]).toEqual(
      expect.objectContaining({ baseUrl: "https://mattermost.example.com" }),
    );
    expect(uploadCall?.[1]?.channelId).toBe("town-square");
    expect(uploadCall?.[1]?.fileName).toBe("photo.png");
    expect(uploadCall?.[1]?.contentType).toBe("image/png");
  });

  it("fails instead of posting text-only when required media cannot be loaded", async () => {
    mockState.loadOutboundMediaFromUrl.mockRejectedValueOnce(new Error("local root denied"));
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });

    await expect(
      sendMessageMattermost("channel:town-square", "hello", {
        cfg: TEST_CFG,
        mediaUrl: "file:///tmp/agent-workspace/photo.png",
        mediaLocalRoots: ["/tmp/agent-workspace"],
        requireMediaUpload: true,
      }),
    ).rejects.toThrow("Mattermost media upload failed: local root denied");

    expect(mockState.createMattermostPost).not.toHaveBeenCalled();
  });

  it("does not fall back to the original image URL after a capped optimized upload fails", async () => {
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.alloc(512),
      fileName: "optimized.jpg",
      contentType: "image/jpeg",
      kind: "image",
    });
    mockState.uploadMattermostFile.mockRejectedValueOnce(new Error("upload unavailable"));
    await expect(
      sendMessageMattermost("channel:town-square", "caption", {
        cfg: { agents: { defaults: { mediaMaxMb: 1 / 1024 } } },
        mediaUrl: "https://example.com/original-large.png",
      }),
    ).rejects.toThrow("upload unavailable");
    expect(mockState.createMattermostPost).not.toHaveBeenCalled();
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

  it("resolves a bare Mattermost user id as a DM target before upload", async () => {
    const userId = "dthcxgoxhifn3pwh65cut3ud3w";
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });
    mockState.fetchMattermostUser.mockResolvedValueOnce({ id: userId });
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("media-bytes"),
      fileName: "photo.png",
      contentType: "image/png",
      kind: "image",
    });

    const result = await sendMessageMattermost(userId, "hello", {
      cfg: TEST_CFG,
      mediaUrl: "file:///tmp/agent-workspace/photo.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.fetchMattermostUser).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://mattermost.example.com" }),
      userId,
    );
    const dmRetryCall = directChannelRetryCall();
    expect(dmRetryCall?.[0]).toEqual(
      expect.objectContaining({ baseUrl: "https://mattermost.example.com" }),
    );
    expect(dmRetryCall?.[1]).toEqual(["bot-user", userId]);
    expect(Object.keys(dmRetryCall?.[2] ?? {})).toEqual(["onRetry"]);
    expect(dmRetryCall?.[2]?.onRetry).toBeTypeOf("function");
    const uploadCall = uploadMattermostFileCall();
    expect(uploadCall?.[0]).toEqual(
      expect.objectContaining({ baseUrl: "https://mattermost.example.com" }),
    );
    expect(uploadCall?.[1]?.channelId).toBe("dm-channel-1");
    expect(result.channelId).toBe("dm-channel-1");
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
  it("parses channel: prefix with non-ID as channel name", () => {
    const target = parseMattermostTarget("channel:abc123");
    expect(target).toEqual({ kind: "channel-name", name: "abc123" });
  });

  it("parses @ prefix as username", () => {
    const target = parseMattermostTarget("@alice");
    expect(target).toEqual({ kind: "user", username: "alice" });
  });

  it("parses # prefix with spaces", () => {
    const target = parseMattermostTarget("  #general  ");
    expect(target).toEqual({ kind: "channel-name", name: "general" });
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

  it("does not apply user-first resolution for explicit channel: prefix", async () => {
    // Unique token + id — explicit channel: prefix, no probe, no DM
    const chanId = "eeeeee5555555555eeeeee5555"; // 26 chars
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-explicit-chan-t5"));

    const onRetry = vi.fn();
    const res = await sendMessageMattermost(`channel:${chanId}`, "hello", {
      cfg: TEST_CFG,
      dmRetryOptions: { maxRetries: 0, onRetry },
    });

    expect(onRetry).not.toHaveBeenCalled();
    expect(mockState.fetchMattermostUser).not.toHaveBeenCalled();
    expect(mockState.createMattermostDirectChannelWithRetry).not.toHaveBeenCalled();
    const params = createMattermostPostParams();
    expect(params.channelId).toBe(chanId);
    expect(res.channelId).toBe(chanId);
  });

  const baseRetry = {
    maxRetries: 4,
    initialDelayMs: 2000,
    maxDelayMs: 8000,
    timeoutMs: 15000,
  };
  const optionRetry = { maxRetries: 5, initialDelayMs: 500, maxDelayMs: 5000, timeoutMs: 10000 };
  const zeroRetry = { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, timeoutMs: 0 };
  const undefinedRetry = {
    maxRetries: undefined,
    initialDelayMs: undefined,
    maxDelayMs: undefined,
    timeoutMs: undefined,
  };
  const baseCallback = vi.fn();
  const overrideCallback = vi.fn();
  const extraBase = { ...baseRetry, onRetry: baseCallback, ignored: "not a retry option" };
  it.each<[string, DmRetryOptions?, DmRetryOptions?, DmRetryOptions?]>([
    ["absent", undefined, undefined, undefined],
    ["empty", {}, {}, undefined],
    ["own-undefined", undefinedRetry, undefinedRetry, undefined],
    ["options-only", undefined, optionRetry, optionRetry],
    ["config-only", baseRetry, undefined, baseRetry],
    [
      "partial",
      { maxRetries: 2, initialDelayMs: 1000 },
      { maxRetries: 7, timeoutMs: 20000 },
      { maxRetries: 7, initialDelayMs: 1000, timeoutMs: 20000 },
    ],
    ["zero", baseRetry, zeroRetry, zeroRetry],
    ["undefined-override", baseRetry, undefinedRetry, baseRetry],
    ["base-extras", extraBase, undefined, baseRetry],
    ["override-callback", {}, { onRetry: overrideCallback }, {}],
  ])("projects frozen %s retry settings", async (name, base, override, expected) => {
    Object.freeze(base);
    Object.freeze(override);
    const userId = `retry-${name}`;
    mockState.resolveMattermostAccount.mockReturnValue(
      makeAccount(`token-${userId}`, { dmChannelRetry: base }),
    );
    const result = await sendMessageMattermost(`user:${userId}`, "hello", {
      cfg: TEST_CFG,
      dmRetryOptions: override,
    });
    const retry = directChannelRetryCall();
    expect(retry[0]).toEqual(
      expect.objectContaining({
        baseUrl: "https://mattermost.example.com",
        token: `token-${userId}`,
      }),
    );
    expect(retry[1]).toEqual(["bot-id", userId]);
    expect(retry[2]).toStrictEqual(
      expected
        ? { ...undefinedRetry, ...expected, onRetry: expect.any(Function) }
        : { onRetry: expect.any(Function) },
    );
    const error = new Error("retry callback identity");
    retry[2]?.onRetry?.(2, 17, error);
    expect(baseCallback).not.toHaveBeenCalled();
    if (override?.onRetry) {
      expect(overrideCallback).toHaveBeenCalledExactlyOnceWith(2, 17, error);
    }
    expect(createMattermostPostParams()).toMatchObject({
      channelId: "dm-channel-id",
      message: "hello",
    });
    expect(result).toMatchObject({ channelId: "dm-channel-id", messageId: "post-id" });
  });

  it("captures retry settings before resolving a bare user id and sends via DM", async () => {
    const userId = "iiiiii9999999999iiiiii9999";
    const entered = createDeferred<void>();
    const release = createDeferred<{ id: string }>();
    const base = { maxRetries: 2, initialDelayMs: 1000 };
    const onRetry = vi.fn();
    const override = { timeoutMs: 20000, onRetry };
    mockState.resolveMattermostAccount.mockReturnValue(
      makeAccount("token-retry-capture", { dmChannelRetry: base }),
    );
    mockState.fetchMattermostUser.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const sending = sendMessageMattermost(userId, "captured", {
      cfg: TEST_CFG,
      dmRetryOptions: override,
    });
    try {
      await entered.promise;
      base.maxRetries = 9;
      override.timeoutMs = 1;
      override.onRetry = vi.fn();
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
      const error = new Error("captured callback");
      retry[2]?.onRetry?.(1, 1000, error);
      expect(onRetry).toHaveBeenCalledExactlyOnceWith(1, 1000, error);
      expect(override.onRetry).not.toHaveBeenCalled();
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

  it("preserves DM creation errors without posting", async () => {
    const error = new Error("DM creation failed");
    mockState.resolveMattermostAccount.mockReturnValue(makeAccount("token-retry-error"));
    mockState.createMattermostDirectChannelWithRetry.mockRejectedValueOnce(error);
    await expect(
      sendMessageMattermost("user:retry-error", "hello", {
        cfg: TEST_CFG,
        dmRetryOptions: zeroRetry,
      }),
    ).rejects.toBe(error);
    expect(directChannelRetryCall()[1]).toEqual(["bot-id", "retry-error"]);
    expect(mockState.createMattermostPost).not.toHaveBeenCalled();
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

  it("bounds DM channel entries without refreshing insertion order on reads", async () => {
    const token = "dm-cache-token";
    for (let index = 0; index < 1024; index += 1) {
      await send(`user:user-${index}`, token);
    }
    await send("user:user-0", token);
    await send("user:user-1024", token);
    await send("user:user-0", token);
    await send("user:user-1024", token);

    expect(mockState.createMattermostDirectChannelWithRetry).toHaveBeenCalledTimes(1026);
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
