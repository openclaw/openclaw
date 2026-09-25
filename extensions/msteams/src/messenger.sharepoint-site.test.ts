import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredConversationReference } from "./conversation-store.js";
import { sendMSTeamsMessages } from "./messenger.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsApp } from "./sdk.js";

const regionalClientState = vi.hoisted(() => ({
  created: [] as string[],
  getById: vi.fn(async () => ({ aadGroupId: "regional-group" })),
}));

const graphUploadMockState = vi.hoisted(() => ({
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
  resolveUploadSiteId: vi.fn(),
}));

vi.mock("@microsoft/teams.api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@microsoft/teams.api")>()),
  Client: vi.fn(function MockClient(this: unknown, serviceUrl: string) {
    regionalClientState.created.push(serviceUrl);
    return {
      serviceUrl,
      teams: { getById: regionalClientState.getById },
      conversations: {
        activities: () => ({
          create: async () => ({ id: "regional-activity" }),
          update: async () => ({ id: "updated" }),
          delete: async () => {},
        }),
      },
    };
  }),
}));

vi.mock("./graph-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph-upload.js")>();
  return {
    ...actual,
    uploadAndShareSharePoint: graphUploadMockState.uploadAndShareSharePoint,
    getDriveItemProperties: graphUploadMockState.getDriveItemProperties,
    resolveUploadSiteId: graphUploadMockState.resolveUploadSiteId,
  };
});

const runtimeStub = {
  config: { loadConfig: () => ({}) },
  channel: {
    text: {
      chunkMarkdownText: (text: string) => [text],
      chunkMarkdownTextWithMode: (text: string) => [text],
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
};

function createMockApp(opts?: {
  getById?: (teamId: string) => Promise<{ aadGroupId?: string }>;
}): MSTeamsApp {
  const createFn = async (activity: unknown) => {
    const text = (activity as Record<string, unknown>)?.text;
    return { id: typeof text === "string" ? `id:${text}` : "created" };
  };
  const apiServiceUrl = "https://smba.trafficmanager.net/amer";
  return {
    client: { request: vi.fn() },
    tokenManager: {
      getBotToken: async () => ({ toString: () => "bot-token" }),
      getGraphToken: async () => ({ toString: () => "graph-token" }),
    },
    send: async (_conversationId: string, activity: unknown) => await createFn(activity),
    reply: async (_conversationId: string, _messageId: string, activity: unknown) =>
      await createFn(activity),
    api: {
      serviceUrl: apiServiceUrl,
      teams: {
        getById: opts?.getById ?? (async () => ({ aadGroupId: "aad-group" })),
      },
      conversations: {
        activities: () => ({
          create: async (activity: unknown) => await createFn(activity),
          update: async () => ({ id: "updated" }),
          delete: async () => {},
        }),
      },
    },
  } as unknown as MSTeamsApp;
}

const baseRef: StoredConversationReference = {
  activityId: "activity123",
  user: { id: "user123", name: "User" },
  agent: { id: "bot123", name: "Bot" },
  conversation: { id: "19:abc@thread.tacv2;messageid=deadbeef" },
  channelId: "msteams",
  serviceUrl: "https://smba.trafficmanager.net/amer/",
};

function createRecordedSendActivity(sink: string[], failFirstWithStatusCode?: number) {
  let attempts = 0;
  return async (activity: unknown) => {
    const { text } = activity as { text?: string };
    const content = text ?? "";
    sink.push(content);
    attempts += 1;
    if (failFirstWithStatusCode !== undefined && attempts === 1) {
      throw Object.assign(new Error("send failed"), { statusCode: failFirstWithStatusCode });
    }
    return { id: `id:${content}` };
  };
}

describe("msteams messenger sharepoint site", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub as never);
    graphUploadMockState.uploadAndShareSharePoint.mockReset();
    graphUploadMockState.getDriveItemProperties.mockReset();
    graphUploadMockState.resolveUploadSiteId.mockReset();
    graphUploadMockState.resolveUploadSiteId.mockImplementation(async (params) => {
      const explicit = params.configuredSiteId?.trim();
      if (explicit) {
        return explicit;
      }
      throw new Error("No SharePoint site ID available for file upload.");
    });
  });

  it("retries media preparation but reuses it after provider dispatch starts", async () => {
    const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-retry-"));
    const localFile = path.join(tmpDir, "retry.txt");
    await writeFile(localFile, "hello");

    try {
      const attempts: string[] = [];
      const providerPayloads: string[] = [];
      const retryEvents: Array<{ nextAttempt: number; delayMs: number }> = [];
      let uploadAttempts = 0;
      graphUploadMockState.uploadAndShareSharePoint.mockImplementation(async () => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          throw Object.assign(new Error("transient upload failure"), { statusCode: 429 });
        }
        return {
          itemId: "item123",
          webUrl: "https://sharepoint.example.com/item123",
          shareUrl: "https://sharepoint.example.com/share/item123",
          name: "retry.txt",
        };
      });
      graphUploadMockState.getDriveItemProperties.mockResolvedValue({
        eTag: '"{ITEM-123},1"',
        webDavUrl: "https://sharepoint.example.com/item123",
        name: "retry.txt",
      });

      const sendActivity = createRecordedSendActivity(attempts, 429);
      const ctx = {
        sendActivity: async (activity: unknown) => {
          providerPayloads.push(JSON.stringify(activity));
          return await sendActivity(activity);
        },
      };
      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp(),
        appId: "app123",
        conversationRef: {
          ...baseRef,
          conversation: {
            ...baseRef.conversation,
            conversationType: "channel",
          },
        },
        context: ctx,
        messages: [{ text: "one", mediaUrl: localFile }],
        tokenProvider: {
          getAccessToken: async () => "token",
        },
        sharePointSiteId: "site-123",
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        onRetry: (e) => retryEvents.push({ nextAttempt: e.nextAttempt, delayMs: e.delayMs }),
      });

      expect(uploadAttempts).toBe(2);
      expect(attempts).toEqual(["one", "one"]);
      expect(providerPayloads[1]).toBe(providerPayloads[0]);
      expect(ids).toEqual(["id:one"]);
      expect(retryEvents).toEqual([
        { nextAttempt: 2, delayMs: 0 },
        { nextAttempt: 3, delayMs: 0 },
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes the SDK team lookup into SharePoint site resolution for channel files", async () => {
    const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-site-"));
    const localFile = path.join(tmpDir, "report.txt");
    await writeFile(localFile, "report");
    const getById = vi.fn(async () => ({ aadGroupId: "aad-group" }));
    graphUploadMockState.resolveUploadSiteId.mockImplementation(async (params) => {
      const teamId = params.teamId;
      if (!teamId) {
        throw new Error("missing teamId");
      }
      await params.getTeamDetails?.(teamId);
      return "resolved-site";
    });
    graphUploadMockState.uploadAndShareSharePoint.mockResolvedValue({
      itemId: "item-cold",
      webUrl: "https://sharepoint.example.com/item-cold",
      shareUrl: "https://sharepoint.example.com/share/item-cold",
      name: "report.txt",
    });
    graphUploadMockState.getDriveItemProperties.mockResolvedValue({
      eTag: '"{ITEM-COLD},1"',
      webDavUrl: "https://sharepoint.example.com/item-cold",
      name: "report.txt",
    });

    try {
      await sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({ getById }),
        appId: "app123",
        conversationRef: {
          ...baseRef,
          teamId: "team-1",
          conversation: {
            id: "19:channel@thread.tacv2",
            conversationType: "channel",
          },
        },
        messages: [{ text: "report", mediaUrl: localFile }],
        tokenProvider: {
          getAccessToken: async () => "token",
        },
      });

      const resolveCall = graphUploadMockState.resolveUploadSiteId.mock.calls[0]?.[0] as {
        teamId?: string;
        channelId?: string;
      };
      expect(resolveCall.teamId).toBe("team-1");
      expect(resolveCall.channelId).toBe("19:channel@thread.tacv2");
      expect(getById).toHaveBeenCalledWith("team-1");
      expect(graphUploadMockState.uploadAndShareSharePoint.mock.calls[0]?.[0]).toMatchObject({
        siteId: "resolved-site",
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("looks up the team on the stored regional endpoint when it differs from the app", async () => {
    const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-regional-"));
    const localFile = path.join(tmpDir, "report.txt");
    await writeFile(localFile, "report");
    const appGetById = vi.fn(async () => ({ aadGroupId: "app-group" }));
    regionalClientState.created.length = 0;
    regionalClientState.getById.mockClear();
    graphUploadMockState.resolveUploadSiteId.mockImplementation(async (params) => {
      await params.getTeamDetails?.(params.teamId);
      return "resolved-site";
    });
    graphUploadMockState.uploadAndShareSharePoint.mockResolvedValue({
      itemId: "item-regional",
      webUrl: "https://sharepoint.example.com/item-regional",
      shareUrl: "https://sharepoint.example.com/share/item-regional",
      name: "report.txt",
    });
    graphUploadMockState.getDriveItemProperties.mockResolvedValue({
      eTag: '"{ITEM-REGIONAL},1"',
      webDavUrl: "https://sharepoint.example.com/item-regional",
      name: "report.txt",
    });

    try {
      await sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({ getById: appGetById }),
        appId: "app123",
        conversationRef: {
          ...baseRef,
          serviceUrl: "https://smba.trafficmanager.net/emea/",
          teamId: "team-1",
          conversation: {
            id: "19:channel@thread.tacv2",
            conversationType: "channel",
          },
        },
        messages: [{ text: "report", mediaUrl: localFile }],
        tokenProvider: {
          getAccessToken: async () => "token",
        },
      });

      expect(regionalClientState.created).toContain("https://smba.trafficmanager.net/emea");
      expect(
        regionalClientState.created.every(
          (serviceUrl) => serviceUrl === "https://smba.trafficmanager.net/emea",
        ),
      ).toBe(true);
      expect(regionalClientState.getById).toHaveBeenCalledWith("team-1");
      expect(appGetById).not.toHaveBeenCalled();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
