import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredConversationReference } from "./conversation-store.js";
import { sendMSTeamsMessages } from "./messenger.js";
import { createMockApp } from "./messenger.test-helpers.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsApp } from "./sdk.js";

const graphUploadMockState = vi.hoisted(() => ({
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
}));

vi.mock("./graph-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph-upload.js")>();
  return {
    ...actual,
    uploadAndShareSharePoint: graphUploadMockState.uploadAndShareSharePoint,
    getDriveItemProperties: graphUploadMockState.getDriveItemProperties,
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

const baseRef: StoredConversationReference = {
  activityId: "activity123",
  user: { id: "user123", name: "User" },
  agent: { id: "bot123", name: "Bot" },
  conversation: { id: "19:abc@thread.tacv2;messageid=deadbeef" },
  channelId: "msteams",
  serviceUrl: "https://smba.trafficmanager.net/amer/",
};

function stubTeamSiteDiscovery(groupId: string, siteId: string) {
  const fetchFn = vi.fn(async (url: string) => {
    const href = url;
    if (href.includes(`teams/${groupId}/`) && href.includes("membershipType")) {
      return Response.json({ membershipType: "standard" });
    }
    if (href.includes(`groups/${groupId}/sites/root`)) {
      return Response.json({ id: siteId });
    }
    throw new Error(`Unexpected SharePoint request: ${href}`);
  });
  vi.stubGlobal("fetch", withFetchPreconnect(fetchFn));
  return fetchFn;
}

describe("msteams messenger sharepoint site", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub as never);
    graphUploadMockState.uploadAndShareSharePoint.mockReset();
    graphUploadMockState.getDriveItemProperties.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers the team site for channel files after a cold start", async () => {
    const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-site-"));
    const localFile = path.join(tmpDir, "report.txt");
    await writeFile(localFile, "report");
    const getById = vi.fn(async () => ({ aadGroupId: "aad-group-a" }));
    const fetchFn = stubTeamSiteDiscovery("aad-group-a", "contoso-site-a");
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
        conversationRef: {
          ...baseRef,
          teamId: "team-a",
          conversation: {
            id: "19:channel-a@thread.tacv2",
            conversationType: "channel",
          },
        },
        messages: [{ text: "report", mediaUrl: localFile }],
        tokenProvider: {
          getAccessToken: async () => "token",
        },
      });

      expect(getById).toHaveBeenCalledWith("team-a");
      const fetched = fetchFn.mock.calls.map(([url]) => url);
      expect(fetched[0]).toContain("aad-group-a");
      expect(fetched[0]).toContain("membershipType");
      expect(fetched[1]).toContain("aad-group-a");
      expect(fetched[1]).toContain("/sites/root");
      expect(graphUploadMockState.uploadAndShareSharePoint.mock.calls[0]?.[0]).toMatchObject({
        siteId: "contoso-site-a",
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("looks up the team on the stored regional endpoint when it differs from the app", async () => {
    const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-regional-"));
    const localFile = path.join(tmpDir, "report.txt");
    await writeFile(localFile, "report");
    const appGetById = vi.fn(async () => ({ aadGroupId: "aad-group-unused" }));
    const regionalGetById = vi.fn(async () => ({ aadGroupId: "aad-group-b" }));
    const createActivity = async (activity: unknown) => {
      const text = (activity as Record<string, unknown>)?.text;
      return { id: typeof text === "string" ? `id:${text}` : "created" };
    };
    const fromServiceUrl = vi.fn(({ serviceUrl }: { serviceUrl: string }) => ({
      serviceUrl,
      fromServiceUrl,
      teams: { getById: regionalGetById },
      conversations: {
        activities: () => ({
          create: createActivity,
        }),
      },
    }));
    const app = {
      api: {
        serviceUrl: "https://smba.trafficmanager.net/amer",
        fromServiceUrl,
        teams: { getById: appGetById },
        conversations: {
          activities: () => ({
            create: createActivity,
          }),
        },
      },
    } as unknown as MSTeamsApp;
    stubTeamSiteDiscovery("aad-group-b", "contoso-site-b");
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
        app,
        conversationRef: {
          ...baseRef,
          serviceUrl: "https://smba.trafficmanager.net/emea/",
          teamId: "team-b",
          conversation: {
            id: "19:channel-b@thread.tacv2",
            conversationType: "channel",
          },
        },
        messages: [{ text: "report", mediaUrl: localFile }],
        tokenProvider: {
          getAccessToken: async () => "token",
        },
      });

      expect(fromServiceUrl).toHaveBeenCalledWith({
        serviceUrl: "https://smba.trafficmanager.net/emea",
      });
      expect(regionalGetById).toHaveBeenCalledWith("team-b");
      expect(appGetById).not.toHaveBeenCalled();
      expect(graphUploadMockState.uploadAndShareSharePoint.mock.calls[0]?.[0]).toMatchObject({
        siteId: "contoso-site-b",
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
