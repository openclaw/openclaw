import { once } from "node:events";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client as TeamsApiClient } from "@microsoft/teams.api";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { teamsQuotedRawTable } from "./format.test-fixtures.js";
import {
  editMessageMSTeams,
  sendAdaptiveCardMSTeams,
  sendMessageMSTeams,
  sendPollMSTeams,
} from "./send.js";

const serviceUrl = "https://smba.trafficmanager.net/amer";
const conversationId = "19:channel@thread.tacv2";

const mockState = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  resolveMSTeamsSendContext: vi.fn(),
  requiresFileConsent: vi.fn(() => false),
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
  buildTeamsFileInfoCard: vi.fn(),
  sendMSTeamsMessages: vi.fn<(typeof import("./messenger.js"))["sendMSTeamsMessages"]>(async () => [
    "text-message-1",
  ]),
}));

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/markdown-table-runtime")>();
  return { ...actual, resolveMarkdownTableMode: vi.fn(() => "off") };
});

vi.mock("openclaw/plugin-sdk/text-chunking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-chunking")>();
  return {
    ...actual,
    convertMarkdownTables: (text: string) => text,
  };
});

vi.mock("./send-context.js", () => ({
  resolveMSTeamsSendContext: mockState.resolveMSTeamsSendContext,
}));

vi.mock("./file-consent-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./file-consent-helpers.js")>()),
  requiresFileConsent: mockState.requiresFileConsent,
  prepareFileConsentActivityFs: vi.fn(),
}));

vi.mock("./graph-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph-upload.js")>();
  return {
    ...actual,
    uploadAndShareSharePoint: mockState.uploadAndShareSharePoint,
    getDriveItemProperties: mockState.getDriveItemProperties,
  };
});

// mock-isolation: fixture file cards must not call the Graph transport.
vi.mock("./graph-chat.js", () => ({ buildTeamsFileInfoCard: mockState.buildTeamsFileInfoCard }));

vi.mock("./messenger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messenger.js")>()),
  sendMSTeamsMessages: mockState.sendMSTeamsMessages,
}));

function mockSendContext(
  api: TeamsApiClient,
  params: {
    conversationType: "channel" | "groupChat" | "personal";
    replyStyle: "thread" | "top-level";
    threadId?: string;
    activityId?: string;
    threadActivityId?: string;
    sharePointSiteId?: string;
    getAccessToken?: ReturnType<typeof vi.fn>;
  },
) {
  const { conversationType, replyStyle, threadId, activityId, threadActivityId, sharePointSiteId } =
    params;
  mockState.resolveMSTeamsSendContext.mockResolvedValue({
    app: { api },
    appId: "app-id",
    conversationId,
    ref: {
      serviceUrl,
      agent: { id: "28:bot", name: "OpenClaw", role: "bot" },
      user: { id: "29:user" },
      conversation: { id: conversationId, conversationType },
      ...(threadId ? { threadId } : {}),
      ...(activityId ? { activityId } : {}),
    },
    conversationType,
    replyStyle,
    ...(threadActivityId ? { threadActivityId } : {}),
    sdkCloudOptions: { cloud: "Public" },
    tokenProvider: { getAccessToken: params.getAccessToken ?? vi.fn(async () => "token") },
    ...(sharePointSiteId ? { sharePointSiteId } : {}),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

type CapturedRequest = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

type TeamsSdkHttpTransport = {
  post: (destination: string, data?: unknown) => Promise<{ data: unknown }>;
  put: (destination: string, data?: unknown) => Promise<{ data: unknown }>;
};

async function withRealTeamsSdkHttp<T>(
  run: (params: { api: TeamsApiClient; requests: CapturedRequest[] }) => Promise<T>,
): Promise<T> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    request.once("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "sdk-http-message-1" }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const port = (server.address() as AddressInfo).port;
    const api = new TeamsApiClient(serviceUrl);
    // OpenClaw's minimal SDK ambient declaration omits the real client's public HTTP transport.
    const transport = (api as unknown as { http: TeamsSdkHttpTransport }).http;
    for (const method of ["post", "put"] as const) {
      vi.spyOn(transport, method).mockImplementation(async (destination, data) => {
        const destinationUrl = new URL(destination);
        const response = await fetch(
          `http://127.0.0.1:${port}${destinationUrl.pathname}${destinationUrl.search}`,
          {
            method: method.toUpperCase(),
            headers: { "content-type": "application/json" },
            body: JSON.stringify(data),
          },
        );
        return { data: await response.json() };
      });
    }

    return await run({ api, requests });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

function mockSharePointFileUpload(): void {
  mockState.loadOutboundMediaFromUrl.mockResolvedValue({
    buffer: Buffer.from("pdf-content"),
    contentType: "application/pdf",
    fileName: "report.pdf",
    kind: "file",
  });
  mockState.uploadAndShareSharePoint.mockResolvedValue({
    itemId: "item-1",
    shareUrl: "https://sharepoint.example.com/shared/report.pdf",
  });
  mockState.getDriveItemProperties.mockResolvedValue({
    eTag: '"file-guid,1"',
    webDavUrl: "https://sharepoint.example.com/dav/report.pdf",
    name: "report.pdf",
  });
  mockState.buildTeamsFileInfoCard.mockReturnValue({
    contentType: "application/vnd.microsoft.teams.card.file.info",
    name: "report.pdf",
  });
}

const threadRoot = "thread-root-1";
const activityRoot = "incoming-activity-1";
const threadedId = `${conversationId};messageid=thread-root-1`;
const attachmentRoutingCases = [
  ["channel thread", "channel", "thread", threadRoot, activityRoot, threadedId],
  [
    "channel activity fallback",
    "channel",
    "thread",
    undefined,
    activityRoot,
    `${conversationId};messageid=incoming-activity-1`,
  ],
  ["top-level channel", "channel", "top-level", threadRoot, undefined, conversationId],
  ["group chat", "groupChat", "thread", threadRoot, undefined, conversationId],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockState.requiresFileConsent.mockReturnValue(false);
  mockState.sendMSTeamsMessages.mockResolvedValue(["text-message-1"]);
  mockSharePointFileUpload();
});

describe.each(["file", "card", "poll"] as const)("Microsoft Teams %s thread routing", (kind) => {
  it.each(
    attachmentRoutingCases.filter((_, index) => kind === "file" || index === 0 || index === 2),
  )(
    "routes %s through the real Teams SDK",
    async (_label, conversationType, replyStyle, threadId, activityId, expectedConversationId) => {
      await withRealTeamsSdkHttp(async ({ api, requests }) => {
        mockSendContext(api, {
          conversationType,
          replyStyle,
          threadId,
          activityId: kind === "file" ? activityId : "incoming-activity-1",
          threadActivityId:
            replyStyle === "thread" && conversationType === "channel"
              ? (threadId ?? activityId)
              : undefined,
          ...(kind === "file" ? { sharePointSiteId: "sharepoint-site-1" } : {}),
        });
        const target = { cfg: {}, to: conversationId };
        const result =
          kind === "file"
            ? await sendMessageMSTeams({
                ...target,
                text: "Here is the report",
                mediaUrl: "https://media.example.com/report.pdf",
              })
            : kind === "card"
              ? await sendAdaptiveCardMSTeams({
                  ...target,
                  card: {
                    type: "AdaptiveCard",
                    version: "1.4",
                    body: [{ type: "TextBlock", text: "Deploy finished" }],
                  },
                })
              : await sendPollMSTeams({ ...target, question: "Ship it?", options: ["Yes", "No"] });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          path: `${new URL(serviceUrl).pathname}/v3/conversations/${expectedConversationId}/activities`,
          body: {
            type: "message",
            conversation: { id: expectedConversationId, conversationType },
            ...(kind === "file"
              ? {
                  text: "Here is the report",
                  attachments: [
                    {
                      contentType: "application/vnd.microsoft.teams.card.file.info",
                      name: "report.pdf",
                    },
                  ],
                }
              : { attachments: [{ contentType: "application/vnd.microsoft.card.adaptive" }] }),
          },
        });
        expect(result).toMatchObject({ messageId: "sdk-http-message-1", conversationId });
      });
    },
  );
});

describe("Microsoft Teams attachments", () => {
  it("delivers a workspace-relative attachment through the real Teams SDK and Bot Framework", async () => {
    await withTempDir("openclaw-msteams-sdk-media-", async (dir) => {
      const workspaceDir = await realpath(dir);
      const filePath = join(workspaceDir, "report.pdf");
      const fileContents = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
      const approvedReader = vi.fn(async (candidate: string) => await readFile(candidate));
      const conflictingReader = vi.fn(async () => Buffer.from("forged Teams attachment"));
      const mediaAccess = { localRoots: [workspaceDir], workspaceDir, readFile: approvedReader };

      await writeFile(filePath, fileContents);
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
        "openclaw/plugin-sdk/outbound-media",
      );
      mockState.loadOutboundMediaFromUrl.mockImplementation(actual.loadOutboundMediaFromUrl);

      await withRealTeamsSdkHttp(async ({ api, requests }) => {
        mockSendContext(api, {
          conversationType: "channel",
          replyStyle: "thread",
          threadId: "workspace-thread-root",
          threadActivityId: "workspace-thread-root",
          sharePointSiteId: "sharepoint-site-1",
        });

        await sendMessageMSTeams({
          cfg: {},
          to: conversationId,
          text: "Workspace report",
          mediaUrl: "report.pdf",
          mediaAccess,
          mediaLocalRoots: [join(workspaceDir, "unapproved")],
          mediaReadFile: conflictingReader,
        });

        expect(approvedReader).toHaveBeenCalledWith(filePath);
        expect(conflictingReader).not.toHaveBeenCalled();
        expect(mockState.loadOutboundMediaFromUrl.mock.calls[0]?.[1]?.mediaAccess).toBe(
          mediaAccess,
        );
        expect(mockState.uploadAndShareSharePoint).toHaveBeenCalledWith(
          expect.objectContaining({ buffer: fileContents, filename: "report.pdf" }),
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          path: `${new URL(serviceUrl).pathname}/v3/conversations/${conversationId};messageid=workspace-thread-root/activities`,
          body: {
            text: "Workspace report",
            attachments: [
              { contentType: "application/vnd.microsoft.teams.card.file.info", name: "report.pdf" },
            ],
          },
        });
      });
    });
  });

  it("keeps personal image delivery on the existing non-SharePoint path", async () => {
    await withRealTeamsSdkHttp(async ({ api, requests }) => {
      mockState.loadOutboundMediaFromUrl.mockResolvedValue({
        buffer: Buffer.from("image-content"),
        contentType: "image/png",
        fileName: "image.png",
        kind: "image",
      });
      mockSendContext(api, {
        conversationType: "personal",
        replyStyle: "thread",
        sharePointSiteId: "sharepoint-site-1",
      });

      const result = await sendMessageMSTeams({
        cfg: {},
        to: conversationId,
        text: "Here is the image",
        mediaUrl: "https://media.example.com/image.png",
      });

      expect(mockState.sendMSTeamsMessages).toHaveBeenCalledOnce();
      expect(mockState.uploadAndShareSharePoint).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      expect(result.messageId).toBe("text-message-1");
    });
  });
});

describe("Teams text preparation at the SDK HTTP boundary", () => {
  const sourceName = String.raw`Alice \[Ops\]`;
  const displayName = "Alice [Ops]";
  const source = `# Deployment status\n\n${teamsQuotedRawTable}\n\n@[${sourceName}](11111111-2222-3333-4444-555555555555)`;
  const expectedText = `**Deployment status**\n\n${teamsQuotedRawTable}\n\n<at>${displayName}</at>`;
  const expectedMention = {
    type: "mention",
    text: `<at>${displayName}</at>`,
    mentioned: { id: "11111111-2222-3333-4444-555555555555", name: displayName },
  };
  const expectedAiEntity = {
    type: "https://schema.org/Message",
    "@type": "Message",
    "@context": "https://schema.org",
    "@id": "",
    additionalType: ["AIGeneratedContent"],
  };

  function expectPrepared(body: Record<string, unknown> | undefined) {
    expect.soft(body).toMatchObject({
      text: expectedText,
      entities: expect.arrayContaining([expectedMention, expectedAiEntity]),
    });
  }

  it.each(["edit", "file-caption"] as const)(
    "preserves normal-send text and mention semantics for %s",
    async (surface) => {
      const actualMessenger =
        await vi.importActual<typeof import("./messenger.js")>("./messenger.js");
      mockState.sendMSTeamsMessages.mockImplementation(actualMessenger.sendMSTeamsMessages);
      await withRealTeamsSdkHttp(async ({ api, requests }) => {
        mockSendContext(api, {
          conversationType: "channel",
          replyStyle: "top-level",
          sharePointSiteId: "sharepoint-site-1",
          getAccessToken: vi.fn(),
        });
        await sendMessageMSTeams({ cfg: {}, to: conversationId, text: source });
        expectPrepared(requests[0]?.body);

        if (surface === "edit") {
          await editMessageMSTeams({
            cfg: {},
            to: conversationId,
            text: source,
            activityId: "sdk-http-message-1",
          });
        } else {
          await sendMessageMSTeams({
            cfg: {},
            to: conversationId,
            text: source,
            mediaUrl: "https://media.example.com/report.pdf",
          });
        }
        expect(requests).toHaveLength(2);
        expect(requests[1]?.method).toBe(surface === "edit" ? "PUT" : "POST");
        expectPrepared(requests[1]?.body);
      });
    },
  );
});
