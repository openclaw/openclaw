import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";
import { msTeamsApprovalNativeRuntime } from "./approval-handler.runtime.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { isMSTeamsNewChannelPost, resolveMSTeamsSendContext } from "./send-context.js";
import { sendMessageMSTeams } from "./send.js";
import { createMSTeamsTestConfig } from "./setup.test-support.js";

const sendContextMockState = vi.hoisted(() => {
  const getAccessToken = vi.fn();
  const createActivity = vi.fn(async () => ({ id: "message-1" }));
  const updateActivity = vi.fn(async () => ({ id: "message-1" }));
  const getActivities = vi.fn(() => ({ create: createActivity, update: updateActivity }));
  const createConversation = vi.fn(async () => ({ id: "a:opened-chat" }));
  const fromServiceUrl = vi.fn(({ serviceUrl }: { serviceUrl: string }) => ({
    serviceUrl,
    conversations: { create: createConversation, activities: getActivities },
  }));
  const store = {
    upsert: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
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
          fromServiceUrl,
          conversations: { activities: getActivities },
        },
      },
    })),
    createMSTeamsTokenProvider: vi.fn(() => ({ getAccessToken })),
    createActivity,
    updateActivity,
    getActivities,
    createConversation,
    fromServiceUrl,
    getAccessToken,
    logInfo: vi.fn(),
    logWarn: vi.fn(),
  };
});

// mock-isolation: this send-context suite substitutes captured conversation references without opening persistent state.
vi.mock("./conversation-store-state.js", () => ({
  createMSTeamsConversationStoreState: sendContextMockState.openConversationStore,
}));

vi.mock("./runtime.js", () => ({
  getOptionalMSTeamsRuntime: () => null,
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: sendContextMockState.logInfo,
        warn: sendContextMockState.logWarn,
      }),
    },
  }),
}));

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: sendContextMockState.loadMSTeamsSdkWithAuth,
  createMSTeamsTokenProvider: sendContextMockState.createMSTeamsTokenProvider,
}));

const {
  store,
  openConversationStore,
  loadMSTeamsSdkWithAuth,
  createMSTeamsTokenProvider,
  createActivity,
  updateActivity,
  getActivities,
  createConversation,
  fromServiceUrl,
  getAccessToken,
  logInfo,
  logWarn,
} = sendContextMockState;

function createConfig(overrides: MSTeamsConfig = {}): OpenClawConfig {
  return createMSTeamsTestConfig({
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
    conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
    channelId: "msteams",
    teamId: "team-1",
    ...params,
  };
}

const conversationId = "19:channel@thread.tacv2";
const serviceUrl = "https://smba.trafficmanager.net/amer/";
function storedChannel(overrides: Partial<StoredConversationReference> = {}) {
  store.get.mockResolvedValue(channelRef({ serviceUrl, ...overrides }));
}
function resolveContext(
  cfg = createConfig(),
  options: Partial<Omit<Parameters<typeof resolveMSTeamsSendContext>[0], "cfg">> = {},
) {
  return resolveMSTeamsSendContext({ cfg, to: `conversation:${conversationId}`, ...options });
}

beforeEach(() => {
  for (const mock of [
    openConversationStore,
    loadMSTeamsSdkWithAuth,
    createMSTeamsTokenProvider,
    createActivity,
    updateActivity,
    getActivities,
    createConversation,
    fromServiceUrl,
  ]) {
    mock.mockClear();
  }
  for (const mock of [...Object.values(store), getAccessToken, logInfo, logWarn]) {
    mock.mockReset();
  }
  vi.unstubAllEnvs();
});

it.each(["channel", "groupChat", "personal"])(
  "applies new-post limits only to a stored channel (%s)",
  async (conversationType) => {
    storedChannel({ conversation: { id: conversationId, conversationType } });
    await expect(
      isMSTeamsNewChannelPost({ accountId: "default", to: conversationId }),
    ).resolves.toBe(conversationType === "channel");
    expect(loadMSTeamsSdkWithAuth).not.toHaveBeenCalled();
  },
);

describe("resolveMSTeamsSendContext", () => {
  it("creates a proactive root without changing normal or explicit thread placement", async () => {
    storedChannel({ threadId: "stored-root" });
    const cfg = createConfig({ replyStyle: "thread" });

    expect(await resolveContext(cfg, { topLevel: true })).toMatchObject({
      replyStyle: "top-level",
    });
    expect(await resolveContext(cfg)).toMatchObject({
      replyStyle: "thread",
      threadActivityId: "stored-root",
    });
    expect(
      await resolveContext(cfg, {
        to: `conversation:${conversationId};messageid=explicit-root`,
        topLevel: true,
      }),
    ).toMatchObject({ replyStyle: "thread", threadActivityId: "explicit-root" });
  });

  it.each([
    ["a:personal-chat", "allow-once", "Allowed once"],
    ["a:personal-chat", "deny", "Denied"],
    ["19:channel@thread.tacv2", "deny", "Denied"],
  ] as const)(
    "edits the original approval card in %s after %s",
    async (targetId, decision, label) => {
      storedChannel({
        conversation: {
          id: targetId,
          conversationType: targetId.startsWith("a:") ? "personal" : "channel",
        },
      });
      const resolved = { id: "approval-1", decision, resolvedBy: "approver-1", ts: 1 };
      const request = {
        id: resolved.id,
        request: { command: "echo approved" },
        createdAtMs: 0,
        expiresAtMs: 2,
      };
      const context = {
        cfg: createConfig(),
        accountId: "default",
        request,
        entry: {
          accountId: "default",
          conversationId: targetId,
          activityId: "message-1",
          actionTokens: [],
        },
      };
      const final = await msTeamsApprovalNativeRuntime.presentation.buildResolvedResult({
        ...context,
        resolved,
        view: {
          approvalId: resolved.id,
          approvalKind: "exec",
          phase: "resolved",
          title: "Exec Approval",
          commandText: "echo approved",
          metadata: [],
          decision,
          resolvedBy: resolved.resolvedBy,
        },
      });
      if (final.kind !== "update") {
        throw new Error("Expected resolved approval card update");
      }
      await msTeamsApprovalNativeRuntime.transport.updateEntry?.({
        ...context,
        approvalKind: "exec",
        phase: "resolved",
        payload: final.payload,
      });
      expect(store.findPreferredDmByUserId).not.toHaveBeenCalled();
      expect(getActivities).toHaveBeenCalledExactlyOnceWith(targetId);
      expect(updateActivity).toHaveBeenCalledExactlyOnceWith(
        "message-1",
        expect.objectContaining({
          id: "message-1",
          attachments: [
            expect.objectContaining({
              content: expect.objectContaining({
                body: expect.arrayContaining([
                  expect.objectContaining({ text: `Exec Approval: ${label}` }),
                ]),
              }),
            }),
          ],
        }),
      );
      expect(final.payload).not.toHaveProperty("actions");
      expect(resolved).toEqual({ id: "approval-1", decision, resolvedBy: "approver-1", ts: 1 });
    },
  );

  it("rejects an unavailable selected certificate before reading conversation state", async () => {
    const certificatePath = "/private/openclaw-msteams-unavailable-send.pem";
    const cfg = createMSTeamsTestConfig({
      enabled: true,
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      certificatePath,
    });

    const error = await resolveContext(cfg).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toBe("msteams credential file is configured but unavailable");
      expect(error.message).not.toContain(certificatePath);
    }
    expect(store.get).not.toHaveBeenCalled();
    expect(loadMSTeamsSdkWithAuth).not.toHaveBeenCalled();
  });

  it("ignores ambient SERVICE_URL for default public-cloud proactive sends", async () => {
    vi.stubEnv("SERVICE_URL", "https://bot.example.com/api/messages");
    storedChannel();
    await expect(resolveContext()).resolves.toMatchObject({
      conversationId,
      sdkCloudOptions: { cloud: "Public" },
    });
  });

  it.each(["conversation:", "graph-team/"])(
    "looks up the base conversation and applies an explicit root via %s",
    async (prefix) => {
      storedChannel({ threadId: "stored-root" });
      await expect(
        resolveContext(createConfig({ replyStyle: "top-level" }), {
          to: `${prefix}${conversationId};messageid=explicit-root`,
        }),
      ).resolves.toMatchObject({
        conversationId: "19:channel@thread.tacv2",
        ref: { threadId: "explicit-root" },
        replyStyle: "thread",
        threadActivityId: "explicit-root",
      });
      expect(store.get).toHaveBeenCalledWith(conversationId);
    },
  );

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
    async ({ conversationType, conversationId: targetId, expectedSuffix }) => {
      storedChannel({
        threadId: "root-1",
        conversation: { id: targetId, conversationType },
      });

      await sendMessageMSTeams({
        cfg: createConfig({ replyStyle: "thread" }),
        to: `conversation:${targetId};messageid=root-1`,
        text: "parity proof",
      });

      expect(store.get).toHaveBeenCalledWith(targetId);
      expect(getActivities).toHaveBeenCalledExactlyOnceWith(`${targetId}${expectedSuffix}`);
      expect(createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation: expect.objectContaining({
            id: `${targetId}${expectedSuffix}`,
            conversationType,
          }),
        }),
      );
    },
  );

  it.each([
    ["the global endpoint", [], "https://smba.trafficmanager.net/teams"],
    [
      "a stored regional endpoint",
      [{ conversationId, reference: channelRef({ serviceUrl }) }],
      "https://smba.trafficmanager.net/amer",
    ],
  ])(
    "opens a personal chat via %s for an installed user who never messaged",
    async (_label, stored, openedVia) => {
      const userId = "00000000-0000-4000-8000-000000000001";
      store.findPreferredDmByUserId.mockResolvedValue(null);
      store.list.mockResolvedValue(stored);

      await sendMessageMSTeams({ cfg: createConfig(), to: `user:${userId}`, text: "hello" });

      expect(fromServiceUrl).toHaveBeenCalledWith({ serviceUrl: openedVia });
      expect(createConversation).toHaveBeenCalledExactlyOnceWith({
        isGroup: false,
        members: [{ id: userId }],
        tenantId: "tenant-id",
        channelData: { tenant: { id: "tenant-id" } },
      });
      expect(store.upsert).toHaveBeenCalledExactlyOnceWith(
        "a:opened-chat",
        expect.objectContaining({
          user: { id: userId, aadObjectId: userId },
          agent: { id: "28:app-id" },
          conversation: {
            id: "a:opened-chat",
            conversationType: "personal",
            tenantId: "tenant-id",
          },
          serviceUrl: openedVia,
        }),
      );
      expect(getActivities).toHaveBeenCalledExactlyOnceWith("a:opened-chat");
      expect(createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "hello",
          conversation: expect.objectContaining({ id: "a:opened-chat" }),
          channelData: expect.objectContaining({ tenant: { id: "tenant-id" } }),
        }),
      );
    },
  );

  it("skips Connector URLs from another cloud before any create request", async () => {
    store.findPreferredDmByUserId.mockResolvedValue(null);
    store.list.mockResolvedValue([{ conversationId, reference: channelRef({ serviceUrl }) }]);

    await expect(
      sendMessageMSTeams({ cfg: createConfig({ cloud: "China" }), to: "user:user-aad", text: "x" }),
    ).rejects.toThrow("No conversation reference found for user:user-aad");

    expect(fromServiceUrl).not.toHaveBeenCalled();
    expect(createConversation).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("does not open a personal chat after delivery authority closes during lookup", async () => {
    const authority = { active: true };
    store.findPreferredDmByUserId.mockImplementation(async () => {
      authority.active = false;
      return null;
    });
    store.list.mockResolvedValue([]);

    await expect(
      sendMessageMSTeams({
        cfg: createConfig(),
        to: "user:user-aad",
        text: "x",
        assertDirectAdapterHandoff: () => {
          if (!authority.active) {
            throw new Error("delivery authority closed");
          }
        },
      }),
    ).rejects.toThrow("delivery authority closed");

    expect(createConversation).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("removes stored conversation references with blocked serviceUrl hosts", async () => {
    storedChannel({ serviceUrl: "https://attacker.example.com/teams/" });
    store.remove.mockResolvedValue(true);

    await expect(resolveContext()).rejects.toThrow(
      /Stored Microsoft Teams conversation reference has blocked serviceUrl host: attacker\.example\.com/,
    );

    expect(store.remove).toHaveBeenCalledWith("19:channel@thread.tacv2");
  });

  it.each([true, undefined])("uses scoped credentials with account enabled=%s", async (enabled) => {
    storedChannel();
    const cfg = createMSTeamsTestConfig({
      enabled,
      tenantId: "tenant-id",
      accounts: {
        ...(enabled
          ? { default: { appId: "default-app-id", appPassword: "default-password", enabled } }
          : {}),
        secondary: {
          enabled,
          appId: "secondary-app-id",
          appPassword: "secondary-app-password",
        },
      },
    });

    await expect(resolveContext(cfg, { accountId: "secondary" })).resolves.toMatchObject({
      accountId: "secondary",
      conversationId,
    });

    expect(store.get).toHaveBeenCalledWith("19:channel@thread.tacv2");
    expect(openConversationStore).toHaveBeenCalledWith({
      accountId: "secondary",
    });
    expect(loadMSTeamsSdkWithAuth).toHaveBeenCalledWith(
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
    const cfg = createMSTeamsTestConfig({
      enabled: false,
      tenantId: "tenant-id",
      accounts: {
        support: {
          enabled: true,
          appId: "support-app-id",
          appPassword: "support-app-password",
        },
      },
    });

    await expect(resolveContext(cfg, { accountId: "support" })).rejects.toThrow(
      "msteams provider is not enabled",
    );
    expect(store.get).not.toHaveBeenCalled();
  });
});

describe("resolveMSTeamsProactiveReplyTarget", () => {
  it.each([
    [{ threadId: "root" }, "root"],
    [{ activityId: "legacy-root" }, "legacy-root"],
    [{}, undefined],
  ] as const)("resolves stored channel root %j", async (ref, threadActivityId) => {
    storedChannel(ref);
    const result = await resolveContext(createConfig({ replyStyle: "thread" }));
    expect({ replyStyle: result.replyStyle, threadActivityId: result.threadActivityId }).toEqual({
      replyStyle: threadActivityId ? "thread" : "top-level",
      threadActivityId,
    });
  });

  it("keeps configured top-level channel routing", async () => {
    const cfg = createConfig({
      replyStyle: "thread",
      teams: {
        "team-1": {
          channels: {
            "19:channel@thread.tacv2": { replyStyle: "top-level" },
          },
        },
      },
    });
    storedChannel({ threadId: "root" });
    const result = await resolveContext(cfg);
    expect([result.replyStyle, result.threadActivityId]).toEqual(["top-level", undefined]);
  });

  it.each(["groupChat", "personal"])("uses top-level for %s", async (conversationType) => {
    storedChannel({
      activityId: "activity-1",
      conversation: { id: conversationId, conversationType },
    });
    const result = await resolveContext(createConfig({ replyStyle: "thread" }));
    expect([result.replyStyle, result.threadActivityId]).toEqual(["top-level", undefined]);
  });
});

describe("stored serviceUrl cloud admission", () => {
  it("rejects a missing URL after SDK setup without creating a token provider or deleting the reference", async () => {
    store.get.mockResolvedValue(channelRef());
    await expect(
      resolveContext(
        createConfig({
          appPassword: "placeholder",
          serviceUrl: "https://smba.trafficmanager.net/teams",
        }),
      ),
    ).rejects.toThrow(
      new Error(
        "msteams proactive send blocked for 19:channel@thread.tacv2: stored conversation reference is missing a valid serviceUrl. " +
          "Ask the bot to receive a new Teams message in this conversation, then retry.",
      ),
    );
    expect(loadMSTeamsSdkWithAuth).toHaveBeenCalledTimes(1);
    expect(createMSTeamsTokenProvider).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });
});
