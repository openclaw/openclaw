import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApp } from "./messenger.test-helpers.js";
import { sendMSTeamsActivityWithReference } from "./sdk-proactive.js";
import type { MSTeamsApp } from "./sdk.js";
import { wasMSTeamsMessageSentWithPersistence } from "./sent-message-cache.js";

const clientState = {
  created: [] as Array<{ serviceUrl: string }>,
  create: vi.fn(async (_payload: { conversationId: string; activity: unknown }) => ({
    id: "activity-1",
  })),
};

function fromServiceUrl({ serviceUrl }: { serviceUrl: string }) {
  clientState.created.push({ serviceUrl });
  return {
    serviceUrl,
    conversations: {
      activities: (conversationId: string) => ({
        create: (activity: unknown) => clientState.create({ conversationId, activity }),
      }),
    },
  };
}

const conversation = Object.freeze({
  id: "19:conversation@thread.tacv2",
  conversationType: "personal",
  tenantId: "tenant-1",
});
const reference = (
  overrides: Partial<Parameters<typeof sendMSTeamsActivityWithReference>[1]> = {},
) => ({
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  user: { id: "29:user" },
  conversation,
  channelId: "msteams",
  ...overrides,
});
const activity = { type: "message", text: "hello" } as const;
const mockApp = () =>
  ({
    api: { serviceUrl: "https://smba.trafficmanager.net/teams", fromServiceUrl },
  }) as unknown as MSTeamsApp;

describe("sendMSTeamsActivityWithReference", () => {
  beforeEach(() => {
    clientState.created.length = 0;
    clientState.create.mockClear().mockResolvedValue({ id: "activity-1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records a channel root only for the sending account and bot", async () => {
    const app = createMockApp({ createFn: async () => ({ id: "account-owned-root" }) });
    await sendMSTeamsActivityWithReference(
      app,
      {
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        agent: { id: "support-bot" },
        conversation: { id: "19:account-scope@thread.tacv2", conversationType: "channel" },
      },
      { type: "message", text: "Account-scoped root" },
      { accountId: "support" },
    );
    const message = {
      conversationId: "19:account-scope@thread.tacv2",
      messageId: "account-owned-root",
      botId: "support-bot",
    };
    await expect(
      wasMSTeamsMessageSentWithPersistence({ ...message, accountId: "support" }),
    ).resolves.toBe(true);
    await expect(
      wasMSTeamsMessageSentWithPersistence({ ...message, accountId: "other" }),
    ).resolves.toBe(false);
    await expect(wasMSTeamsMessageSentWithPersistence(message)).resolves.toBe(false);
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        ...message,
        accountId: "support",
        botId: "other-bot",
      }),
    ).resolves.toBe(false);
  });

  it("sends a legacy bot-only imported reference instead of rejecting it", async () => {
    vi.stubEnv("SERVICE_URL", "https://bot.example.com/api/messages");
    const result = await sendMSTeamsActivityWithReference(
      mockApp(),
      reference({ bot: { id: "28:legacy-bot", name: "OpenClaw" } }),
      activity,
    );

    expect(result).toMatchObject({ id: "activity-1" });
    expect(clientState.create).toHaveBeenCalledTimes(1);
  });

  it("sends through a reference-scoped API client without the protected SDK activitySender", async () => {
    vi.stubEnv("SERVICE_URL", "https://bot.example.com/api/messages");
    const app = {
      api: {
        serviceUrl: "https://smba.trafficmanager.net/teams",
        fromServiceUrl,
        conversations: {
          activities: () => ({
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
          }),
        },
      },
    } as unknown as MSTeamsApp;

    const result = await sendMSTeamsActivityWithReference(
      app,
      reference({
        agent: { id: "28:bot", name: "OpenClaw", role: "bot" },
        user: { id: "29:user", aadObjectId: "aad-user" },
      }),
      activity,
      { serviceUrlBoundary: { cloud: "Public" } },
    );

    expect(result).toMatchObject({ id: "activity-1" });
    expect(clientState.created).toEqual([{ serviceUrl: "https://smba.trafficmanager.net/amer" }]);
    expect(clientState.create).toHaveBeenCalledWith({
      conversationId: "19:conversation@thread.tacv2",
      activity: expect.objectContaining({
        type: "message",
        text: "hello",
        from: { id: "28:bot", name: "OpenClaw", role: "bot" },
        conversation,
        channelData: { tenant: { id: "tenant-1" } },
      }),
    });
  });
});

describe("stored serviceUrl SDK admission", () => {
  it.each([
    {
      agent: undefined,
      serviceUrl: undefined,
      message: "Invalid stored reference: missing agent.id",
    },
    {
      agent: { id: "28:bot" },
      serviceUrl: undefined,
      message: "Invalid stored reference: missing serviceUrl",
    },
    {
      agent: { id: "28:bot" },
      serviceUrl: "https://msteams.botframework.azure.cn/teams/",
      message:
        "msteams proactive send blocked for 19:conversation@thread.tacv2: stored conversation serviceUrl (https://msteams.botframework.azure.cn/teams) requires channels.msteams.cloud=China.",
    },
  ])("preserves validation order: $message", async ({ agent, serviceUrl, message }) => {
    clientState.created.length = 0;
    clientState.create.mockClear();
    const app = {
      client: { request: vi.fn() },
      api: { serviceUrl: "https://smba.trafficmanager.net/teams" },
    } as unknown as MSTeamsApp;
    await expect(
      sendMSTeamsActivityWithReference(
        app,
        { agent, serviceUrl, conversation: { id: "19:conversation@thread.tacv2" } },
        activity,
        { serviceUrlBoundary: { cloud: "Public" } },
      ),
    ).rejects.toThrow(new Error(message));
    expect(clientState.created).toEqual([]);
    expect(clientState.create).not.toHaveBeenCalled();
  });
});
