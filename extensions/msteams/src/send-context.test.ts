import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { resolveMSTeamsSendContext } from "./send-context.js";
import { sendMessageMSTeams } from "./send.js";

const mocks = vi.hoisted(() => {
  const createActivity = vi.fn(async () => ({ id: "message-1" }));
  const getActivities = vi.fn(() => ({ create: createActivity }));
  const store = {
    get: vi.fn(),
    remove: vi.fn(),
    findPreferredDmByUserId: vi.fn(),
  };
  return {
    store,
    openConversationStore: vi.fn(() => store),
    loadMSTeamsSdkWithAuth: vi.fn(async () => ({
      app: {
        id: "mock-app",
        api: {
          serviceUrl: "https://smba.trafficmanager.net/amer/",
          fromServiceUrl: ({ serviceUrl }: { serviceUrl: string }) => ({
            serviceUrl,
            conversations: { activities: getActivities },
          }),
          conversations: { activities: getActivities },
        },
      },
    })),
    createMSTeamsTokenProvider: vi.fn(() => ({ getAccessToken: vi.fn() })),
    createActivity,
    getActivities,
  };
});

// mock-isolation: this send-context suite substitutes captured conversation references without opening persistent state.
vi.mock("./conversation-store-state.js", () => ({
  createMSTeamsConversationStoreState: mocks.openConversationStore,
}));

vi.mock("./runtime.js", () => ({
  getOptionalMSTeamsRuntime: () => null,
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
    },
  }),
}));

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: mocks.loadMSTeamsSdkWithAuth,
  createMSTeamsTokenProvider: mocks.createMSTeamsTokenProvider,
}));

const channelId = "19:channel@thread.tacv2";
const destination = `conversation:${channelId}`;

function resolveContext(params: Partial<Parameters<typeof resolveMSTeamsSendContext>[0]> = {}) {
  return resolveMSTeamsSendContext({ cfg: createConfig(), to: destination, ...params });
}

function createConfig(overrides: MSTeamsConfig = {}): OpenClawConfig {
  return teamsConfig({
    enabled: true,
    appId: "app-id",
    appPassword: "app-password",
    tenantId: "tenant-id",
    ...overrides,
  });
}

function channelRef(params?: Partial<StoredConversationReference>): StoredConversationReference {
  return {
    user: { id: "user-1" },
    agent: { id: "agent-1" },
    conversation: { id: channelId, conversationType: "channel" },
    channelId: "msteams",
    teamId: "team-1",
    ...params,
  };
}

function storeRef(overrides: Partial<StoredConversationReference> = {}) {
  mocks.store.get.mockResolvedValue(
    channelRef({ serviceUrl: "https://smba.trafficmanager.net/amer/", ...overrides }),
  );
}

async function resolveReply(cfg: MSTeamsConfig, ref: StoredConversationReference) {
  storeRef(ref);
  const { replyStyle, threadActivityId } = await resolveContext({
    cfg: createConfig({ appPassword: "placeholder", ...cfg }),
  });
  return { replyStyle, threadActivityId };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(mocks.store)) {
    mock.mockReset();
  }
  vi.unstubAllEnvs();
});

function account(name: string) {
  return { enabled: true, appId: `${name}-app-id`, appPassword: `${name}-app-password` };
}

function teamsConfig(msteams: MSTeamsConfig): OpenClawConfig {
  return { channels: { msteams } };
}

describe("resolveMSTeamsSendContext", () => {
  it("rejects an unavailable selected certificate before reading conversation state", async () => {
    const certificatePath = "/private/openclaw-msteams-unavailable-send.pem";
    const cfg = createConfig({ appPassword: undefined, authType: "federated", certificatePath });

    await expect(resolveContext({ cfg })).rejects.toThrow(
      new Error("msteams credential file is configured but unavailable"),
    );
    expect(mocks.store.get).not.toHaveBeenCalled();
    expect(mocks.loadMSTeamsSdkWithAuth).not.toHaveBeenCalled();
  });

  it("ignores ambient SERVICE_URL for default public-cloud proactive sends", async () => {
    vi.stubEnv("SERVICE_URL", "https://bot.example.com/api/messages");
    sendContextMockState.store.get.mockResolvedValue(
      channelRef({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      }),
    );

    const cfg = createConfig();

    await expect(
      resolveMSTeamsSendContext({
        cfg,
        to: "conversation:19:channel@thread.tacv2",
      }),
    ).resolves.toMatchObject({
      conversationId: "19:channel@thread.tacv2",
      sdkCloudOptions: { cloud: "Public" },
    });
  });

  it("looks up the base conversation and applies an explicit thread root", async () => {
    sendContextMockState.store.get.mockResolvedValue(
      channelRef({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        threadId: "stored-root",
      }),
    );

    await expect(
      resolveMSTeamsSendContext({
        cfg: createConfig({ replyStyle: "top-level" }),
        to: "conversation:19:channel@thread.tacv2;messageid=explicit-root",
      }),
    ).resolves.toMatchObject({
      conversationId: "19:channel@thread.tacv2",
      ref: { threadId: "explicit-root" },
      replyStyle: "thread",
      threadActivityId: "explicit-root",
    });
    expect(sendContextMockState.store.get).toHaveBeenCalledWith("19:channel@thread.tacv2");
  });

  it.each([
    { conversationType: "personal", conversationId: "a:dm", expectedSuffix: "" },
    { conversationType: "groupChat", conversationId: "19:g@thread.v2", expectedSuffix: "" },
    {
      conversationType: "channel",
      conversationId: "19:c@thread.tacv2",
      expectedSuffix: ";messageid=root-1",
    },
  ] as const)(
    "sends explicit threaded $conversationType targets to the correct SDK conversation",
    async ({ conversationType, conversationId, expectedSuffix }) => {
      storeRef({
        threadId: "root-1",
        conversation: { id: conversationId, conversationType },
      });

      await sendMessageMSTeams({
        cfg: createConfig({ replyStyle: "thread" }),
        to: `conversation:${conversationId};messageid=root-1`,
        text: "parity proof",
      });

      expect(mocks.store.get).toHaveBeenCalledWith(conversationId);
      expect(mocks.getActivities).toHaveBeenCalledExactlyOnceWith(
        `${conversationId}${expectedSuffix}`,
      );
      expect(mocks.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation: expect.objectContaining({
            id: `${conversationId}${expectedSuffix}`,
            conversationType,
          }),
        }),
      );
    },
  );

  it("resolves Graph team/channel targets through the stored channel conversation", async () => {
    storeRef({ threadId: "stored-root" });

    await expect(
      resolveContext({
        cfg: createConfig({ replyStyle: "top-level" }),
        to: "graph-team/19:channel@thread.tacv2;messageid=graph-root",
      }),
    ).resolves.toMatchObject({
      conversationId: channelId,
      ref: { threadId: "graph-root" },
      replyStyle: "thread",
      threadActivityId: "graph-root",
    });
    expect(mocks.store.get).toHaveBeenCalledWith(channelId);
  });

  it("removes stored conversation references with blocked serviceUrl hosts", async () => {
    storeRef({ serviceUrl: "https://attacker.example.com/teams/" });
    mocks.store.remove.mockResolvedValue(true);

    await expect(resolveContext()).rejects.toThrow(
      /Stored Microsoft Teams conversation reference has blocked serviceUrl host: attacker\.example\.com/,
    );

    expect(mocks.store.remove).toHaveBeenCalledWith(channelId);
  });

  it("uses named account credentials and scoped conversation references", async () => {
    storeRef();

    const cfg = teamsConfig({
      enabled: true,
      tenantId: "tenant-id",
      accounts: {
        default: account("default"),
        secondary: account("secondary"),
      },
    });

    await expect(
      resolveContext({
        cfg,
        accountId: "secondary",
      }),
    ).resolves.toMatchObject({ conversationId: channelId });

    expect(mocks.store.get).toHaveBeenCalledWith(channelId);
    expect(mocks.openConversationStore).toHaveBeenCalledWith({ accountId: "secondary" });
    expect(mocks.loadMSTeamsSdkWithAuth).toHaveBeenCalledWith(
      {
        appId: "secondary-app-id",
        appPassword: "secondary-app-password",
        tenantId: "tenant-id",
        type: "secret",
      },
      { cloud: "Public" },
    );
  });

  it("rejects named sends when the Teams channel is disabled globally", async () => {
    const cfg = teamsConfig({
      enabled: false,
      tenantId: "tenant-id",
      accounts: {
        support: account("support"),
      },
    });

    await expect(
      resolveContext({
        cfg,
        accountId: "support",
      }),
    ).rejects.toThrow("msteams provider is not enabled");
    expect(mocks.store.get).not.toHaveBeenCalled();
  });

  it("treats omitted account enabled as enabled for proactive sends", async () => {
    sendContextMockState.store.get.mockResolvedValue(
      channelRef({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      }),
    );

    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          accounts: {
            secondary: {
              appId: "secondary-app-id",
              appPassword: "secondary-app-password",
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      resolveMSTeamsSendContext({
        cfg,
        accountId: "secondary",
        to: "conversation:19:channel@thread.tacv2",
      }),
    ).resolves.toMatchObject({
      accountId: "secondary",
      conversationId: "19:channel@thread.tacv2",
    });
  });
});

describe("resolveMSTeamsProactiveReplyTarget", () => {
  it("uses thread for channel conversations with a stored thread root", async () => {
    await expect(
      resolveMSTeamsProactiveReplyTarget({
        cfg: {},
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef({ threadId: "thread-root-1" }),
        conversationType: "channel",
      }),
    ).resolves.toEqual({ replyStyle: "thread", threadActivityId: "thread-root-1" });
  });

  it("falls back to activityId for legacy channel references", async () => {
    await expect(resolveReply({}, channelRef({ activityId: "legacy-root-1" }))).resolves.toEqual({
      replyStyle: "thread",
      threadActivityId: "legacy-root-1",
    });
  });

  it("keeps configured top-level channel routing", async () => {
    const cfg: MSTeamsConfig = {
      replyStyle: "thread",
      teams: { "team-1": { channels: { [channelId]: { replyStyle: "top-level" } } } },
    };

    await expect(resolveReply(cfg, channelRef({ threadId: "thread-root-1" }))).resolves.toEqual({
      replyStyle: "top-level",
      threadActivityId: undefined,
    });
  });

  it("uses top-level when a channel has no stored thread root", async () => {
    await expect(
      resolveMSTeamsProactiveReplyTarget({
        cfg: { replyStyle: "thread" },
        conversationId: "19:channel@thread.tacv2",
        ref: channelRef(),
        conversationType: "channel",
      }),
    ).resolves.toEqual({ replyStyle: "top-level", threadActivityId: undefined });
  });

  it("uses top-level for non-channel conversations", async () => {
    const ref = channelRef({ activityId: "activity-1" });

    await expect(
      resolveMSTeamsProactiveReplyTarget({
        cfg: { replyStyle: "thread" },
        conversationId: "19:group@thread.v2",
        ref,
        conversationType: "groupChat",
      }),
    ).resolves.toEqual({ replyStyle: "top-level", threadActivityId: undefined });
    await expect(
      resolveMSTeamsProactiveReplyTarget({
        cfg: { replyStyle: "thread" },
        conversationId: "a:personal",
        ref,
        conversationType: "personal",
      }),
    ).resolves.toEqual({ replyStyle: "top-level", threadActivityId: undefined });
  });
});

describe("stored serviceUrl cloud admission", () => {
  it("rejects a missing URL after SDK setup without creating a token provider or deleting the reference", async () => {
    mocks.store.get.mockResolvedValue(channelRef());
    await expect(
      resolveContext({
        cfg: createConfig({
          appPassword: "placeholder",
          serviceUrl: "https://smba.trafficmanager.net/teams",
        }),
      }),
    ).rejects.toThrow(
      new Error(
        "msteams proactive send blocked for 19:channel@thread.tacv2: stored conversation reference is missing a valid serviceUrl. " +
          "Ask the bot to receive a new Teams message in this conversation, then retry.",
      ),
    );
    expect(mocks.loadMSTeamsSdkWithAuth).toHaveBeenCalledTimes(1);
    expect(mocks.createMSTeamsTokenProvider).not.toHaveBeenCalled();
    expect(mocks.store.remove).not.toHaveBeenCalled();
  });
});
