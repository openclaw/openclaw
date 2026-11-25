import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApp } from "./messenger.test-helpers.js";
import { sendMSTeamsActivityWithReference as sendWithReference } from "./sdk-proactive.js";
import type { MSTeamsApp } from "./sdk.js";
import { wasMSTeamsMessageSentWithPersistence as wasSent } from "./sent-message-cache.js";

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
const reference = (overrides: Partial<Parameters<typeof sendWithReference>[1]> = {}) => ({
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  user: { id: "29:user" },
  conversation,
  channelId: "msteams",
  ...overrides,
});
const activity = { type: "message", text: "hello" } as const;
function mockApp(legacy: boolean) {
  const api = { serviceUrl: "https://smba.trafficmanager.net/teams", fromServiceUrl };
  if (!legacy) {
    Object.assign(api, {
      conversations: {
        activities: () => ({ create: vi.fn(), update: vi.fn(), delete: vi.fn() }),
      },
    });
  }
  return { api } as unknown as MSTeamsApp;
}

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
    await sendWithReference(
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
    expect([
      await wasSent({ ...message, accountId: "support" }),
      await wasSent({ ...message, accountId: "other" }),
      await wasSent(message),
      await wasSent({ ...message, accountId: "support", botId: "other-bot" }),
    ]).toEqual([true, false, false, false]);
  });

  it.each([true, false])("uses the reference-scoped client for legacy=%s", async (legacy) => {
    vi.stubEnv("SERVICE_URL", "https://bot.example.com/api/messages");
    const result = await sendWithReference(
      mockApp(legacy),
      reference(
        legacy
          ? { bot: { id: "28:legacy-bot", name: "OpenClaw" } }
          : {
              agent: { id: "28:bot", name: "OpenClaw", role: "bot" },
              user: { id: "29:user", aadObjectId: "aad-user" },
            },
      ),
      activity,
      legacy ? undefined : { serviceUrlBoundary: { cloud: "Public" } },
    );
    expect(result).toMatchObject({ id: "activity-1" });
    expect(clientState.create).toHaveBeenCalledTimes(1);
    if (!legacy) {
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
    }
  });
});

it.each([
  [undefined, undefined, "Invalid stored reference: missing agent.id"],
  [{ id: "28:bot" }, undefined, "Invalid stored reference: missing serviceUrl"],
  [
    { id: "28:bot" },
    "https://msteams.botframework.azure.cn/teams/",
    "msteams proactive send blocked for 19:conversation@thread.tacv2: stored conversation serviceUrl (https://msteams.botframework.azure.cn/teams) requires channels.msteams.cloud=China.",
  ],
] as const)("rejects invalid reference %#", async (agent, serviceUrl, message) => {
  clientState.created.length = 0;
  clientState.create.mockClear();
  const app = {
    api: { serviceUrl: "https://smba.trafficmanager.net/teams" },
  } as unknown as MSTeamsApp;
  await expect(
    sendWithReference(
      app,
      { agent, serviceUrl, conversation: { id: "19:conversation@thread.tacv2" } },
      activity,
      { serviceUrlBoundary: { cloud: "Public" } },
    ),
  ).rejects.toThrow(new Error(message));
  expect(clientState.created).toEqual([]);
  expect(clientState.create).not.toHaveBeenCalled();
});
