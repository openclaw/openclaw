import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMSTeamsMessages } from "./messenger.js";
import { createMockApp, createStoredReference } from "./messenger.test-helpers.js";
import { sendMessageMSTeams } from "./send.js";

const state = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("./send-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send-context.js")>()),
  resolveMSTeamsSendContext: state.context,
}));
vi.mock("openclaw/plugin-sdk/outbound-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/outbound-media")>()),
  loadOutboundMediaFromUrl: async () => ({
    buffer: Buffer.from("report"),
    contentType: "text/plain",
    fileName: "report.txt",
  }),
}));
vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMedia: async () => ({
    buffer: Buffer.from("report"),
    contentType: "text/plain",
    fileName: "report.txt",
    kind: "file",
  }),
}));

afterEach(() => vi.unstubAllGlobals());

let fixtureId = 0;
function fixture() {
  const id = ++fixtureId;
  const activities: unknown[] = [];
  const app = createMockApp({
    createFn: async (activity) => {
      activities.push(activity);
      return { id: "sent" };
    },
  });
  const teamLookup = vi.fn(async () => ({ aadGroupId: "group-a" }));
  const regionalApi = { ...app.api, teams: { getById: teamLookup } };
  app.api.fromServiceUrl = vi.fn(() => regionalApi);
  app.api.teams = {
    getById: vi.fn(async () => {
      throw new Error("wrong region");
    }),
  };
  const ref = createStoredReference({
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    tenantId: `tenant-${id}`,
    teamId: `19:team-${id}@thread.tacv2`,
    conversation: { id: "19:channel-a@thread.tacv2;messageid=123", conversationType: "channel" },
  });
  const tokenProvider = { getAccessToken: vi.fn(async () => "graph-token") };
  const requests: string[] = [];
  let membershipType = "standard";
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer graph-token");
    if (url.includes("/channels/")) {
      return Response.json({ membershipType });
    }
    if (url.includes("/groups/")) {
      return Response.json({ id: url.includes("group-b") ? "site-b" : "site-a" });
    }
    if (init?.method === "PUT") {
      return Response.json({ id: "item-a" });
    }
    if (url.includes("createLink")) {
      return Response.json({});
    }
    if (url.includes("/items/")) {
      return Response.json({
        eTag: '"file,1"',
        webDavUrl: "https://contoso.sharepoint.com/report.txt",
        name: "report.txt",
      });
    }
    throw new Error(`Unexpected Graph request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchFn);
  return {
    app,
    ref,
    tokenProvider,
    teamLookup,
    activities,
    requests,
    setMembership: (value: string) => {
      membershipType = value;
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
async function sendFile(
  lane: string,
  f: Fixture,
  options: { siteId?: string; accountId?: string; assertDirectAdapterHandoff?: () => void } = {},
) {
  const { siteId, accountId = "default", assertDirectAdapterHandoff } = options;
  if (lane === "proactive") {
    state.context.mockResolvedValue({
      app: f.app,
      ref: f.ref,
      accountId,
      conversationId: f.ref.conversation?.id,
      conversationType: "channel",
      tokenProvider: f.tokenProvider,
      sharePointSiteId: siteId,
      replyStyle: "top-level",
      sdkCloudOptions: { cloud: "Public" },
    });
    return sendMessageMSTeams({
      cfg: {},
      to: "conversation:19:channel-a@thread.tacv2",
      text: "report",
      mediaUrl: "/synthetic/report.txt",
      assertDirectAdapterHandoff,
    });
  }
  return sendMSTeamsMessages({
    app: f.app,
    conversationRef: f.ref,
    accountId,
    replyStyle: "top-level",
    tokenProvider: f.tokenProvider,
    sharePointSiteId: siteId,
    messages: [{ mediaUrl: "/synthetic/report.txt" }],
    assertDirectAdapterHandoff,
  });
}

describe.each(["proactive", "reply"])("%s channel file sends", (lane) => {
  it("discovers and caches each team site within its account, using the regional reference", async () => {
    const f = fixture();
    await sendFile(lane, f);
    expect(f.teamLookup).toHaveBeenCalledWith(f.ref.teamId);
    expect(f.requests).toContain("https://graph.microsoft.com/v1.0/groups/group-a/sites/root");
    expect(f.requests.some((url) => url.includes("/sites/site-a/drive/root:"))).toBe(true);
    expect(f.activities).toEqual([
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            contentType: "application/vnd.microsoft.teams.card.file.info",
            contentUrl: "https://contoso.sharepoint.com/report.txt",
          }),
        ],
      }),
    ]);
    const teamA = f.ref.teamId;
    f.ref.teamId = `${teamA}-b`;
    f.teamLookup.mockResolvedValue({ aadGroupId: "group-b" });
    await sendFile(lane, f);
    f.ref.teamId = teamA;
    await sendFile(lane, f);
    await sendFile(lane, f, { accountId: "other-account" });
    expect(f.requests.filter((url) => url.includes("/groups/"))).toEqual([
      "https://graph.microsoft.com/v1.0/groups/group-a/sites/root",
      "https://graph.microsoft.com/v1.0/groups/group-b/sites/root",
      "https://graph.microsoft.com/v1.0/groups/group-a/sites/root",
    ]);
    expect(
      f.requests
        .filter((url) => url.includes("/drive/root:"))
        .map((url) => url.split("/sites/")[1]?.split("/")[0]),
    ).toEqual(["site-a", "site-b", "site-a", "site-a"]);
  });

  it("stops discovery when authority closes during team lookup", async () => {
    const f = fixture();
    let current = true;
    f.teamLookup.mockImplementation(async () => {
      current = false;
      return { aadGroupId: "group-a" };
    });
    await expect(
      sendFile(lane, f, {
        assertDirectAdapterHandoff: () => {
          if (!current) {
            throw new Error("delivery revoked");
          }
        },
      }),
    ).rejects.toThrow("delivery revoked");
    expect(f.tokenProvider.getAccessToken).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
    expect(f.activities).toEqual([]);
  });

  it("retains explicit sites and rejects private/shared discovery before uploading", async () => {
    const f = fixture();
    await expect(sendFile(lane, f, { siteId: "  " })).rejects.toThrow("sharePointSiteId");
    expect(f.requests).toEqual([]);
    for (const membership of ["private", "shared"]) {
      f.setMembership(membership);
      await expect(sendFile(lane, f)).rejects.toThrow("standard channels only");
    }
    expect(f.requests.every((url) => url.includes("/channels/"))).toBe(true);
    f.requests.length = 0;
    await sendFile(lane, f, { siteId: " configured-site " });
    expect(f.requests.every((url) => url.includes("/sites/configured-site/"))).toBe(true);
    expect(f.activities).toHaveLength(1);
  });
});
