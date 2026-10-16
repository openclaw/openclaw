// Msteams tests cover send plugin behavior.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  deleteMessageMSTeams,
  editAdaptiveCardMSTeams,
  editMessageMSTeams,
  sendMessageMSTeams,
} from "./send.js";

const mockState = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  resolveMSTeamsSendContext: vi.fn(),
  resolveMarkdownTableMode: vi.fn<
    typeof import("openclaw/plugin-sdk/markdown-table-runtime").resolveMarkdownTableMode
  >(() => "off"),
  convertMarkdownTables: vi.fn<
    typeof import("openclaw/plugin-sdk/text-chunking").convertMarkdownTables
  >((text) => text),
  runtimeResolveMarkdownTableMode: vi.fn(() => "off"),
  runtimeConvertMarkdownTables: vi.fn((text: string) => text),
  requiresFileConsent: vi.fn(),
  prepareFileConsentActivity: vi.fn(),
  prepareFileConsentActivityFs: vi.fn(),
  setPendingUploadActivityIdFs: vi.fn(),
  extractFilename: vi.fn(async () => "fallback.bin"),
  sendMSTeamsMessages: vi.fn<typeof import("./messenger.js").sendMSTeamsMessages>(),
  sendMSTeamsActivityWithReference: vi.fn(async () => ({ id: "message-1" })),
  updateMSTeamsActivityWithReference: vi.fn<
    typeof import("./sdk-proactive.js").updateMSTeamsActivityWithReference
  >(async () => ({ id: "updated" })),
  deleteMSTeamsActivityWithReference: vi.fn(async () => {}),
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
  buildTeamsFileInfoCard: vi.fn(),
  createMSTeamsTokenProvider: vi.fn(),
}));

// `loadOutboundMediaFromUrl` is re-exported from msteams's runtime-api which
// pulls from `openclaw/plugin-sdk/outbound-media` (post-migration). Mock the
// canonical source so the re-export carries our stub through.
vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/markdown-table-runtime")>();
  return { ...actual, resolveMarkdownTableMode: mockState.resolveMarkdownTableMode };
});

vi.mock("openclaw/plugin-sdk/text-chunking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-chunking")>();
  return {
    ...actual,
    convertMarkdownTables: mockState.convertMarkdownTables,
  };
});

vi.mock("./send-context.js", () => ({
  resolveMSTeamsSendContext: mockState.resolveMSTeamsSendContext,
}));

vi.mock("./file-consent-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./file-consent-helpers.js")>()),
  requiresFileConsent: mockState.requiresFileConsent,
  prepareFileConsentActivity: mockState.prepareFileConsentActivity,
  prepareFileConsentActivityFs: mockState.prepareFileConsentActivityFs,
}));

vi.mock("./pending-uploads-fs.js", () => ({
  setPendingUploadActivityIdFs: mockState.setPendingUploadActivityIdFs,
}));

vi.mock("./media-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-helpers.js")>()),
  extractFilename: mockState.extractFilename,
  extractMessageId: () => "message-1",
}));

vi.mock("./messenger.js", () => ({
  sendMSTeamsMessages: mockState.sendMSTeamsMessages,
  buildConversationReference: (ref: Record<string, unknown>) => ({
    serviceUrl: (ref as { serviceUrl?: string }).serviceUrl ?? "https://service.example.com",
    conversation: (ref as { conversation?: Record<string, unknown> }).conversation ?? {
      id: "19:conversation@thread.tacv2",
    },
    agent: (ref as { agent?: Record<string, unknown> }).agent,
    user: (ref as { user?: Record<string, unknown> }).user,
    tenantId: (ref as { tenantId?: string }).tenantId,
    aadObjectId: (ref as { aadObjectId?: string }).aadObjectId,
  }),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: mockState.runtimeResolveMarkdownTableMode,
        convertMarkdownTables: mockState.runtimeConvertMarkdownTables,
      },
    },
  }),
}));

vi.mock("./graph-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph-upload.js")>();
  return {
    ...actual,
    uploadAndShareSharePoint: mockState.uploadAndShareSharePoint,
    getDriveItemProperties: mockState.getDriveItemProperties,
  };
});

vi.mock("./graph-chat.js", () => ({ buildTeamsFileInfoCard: mockState.buildTeamsFileInfoCard }));

vi.mock("./sdk.js", () => ({ createMSTeamsTokenProvider: mockState.createMSTeamsTokenProvider }));

vi.mock("./sdk-proactive.js", () => ({
  sendMSTeamsActivityWithReference: mockState.sendMSTeamsActivityWithReference,
  updateMSTeamsActivityWithReference: mockState.updateMSTeamsActivityWithReference,
  deleteMSTeamsActivityWithReference: mockState.deleteMSTeamsActivityWithReference,
}));

const conversationId = "19:conversation@thread.tacv2";
const destination = { cfg: {}, to: `conversation:${conversationId}` };

function mockProactiveSendContextFailure(error: string) {
  mockState.sendMSTeamsActivityWithReference.mockRejectedValue(new Error(error));
  mockState.updateMSTeamsActivityWithReference.mockRejectedValue(new Error(error));
  mockState.deleteMSTeamsActivityWithReference.mockRejectedValue(new Error(error));
  mockState.resolveMSTeamsSendContext.mockResolvedValue({
    app: { id: "failing-app" },
    appId: "app-id",
    conversationId,
    ref: {
      user: { id: "user-1" },
      agent: { id: "agent-1" },
      conversation: { id: conversationId },
      channelId: "msteams",
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    conversationType: "personal",
    sdkCloudOptions: { cloud: "Public" },
    tokenProvider: {},
  });
}

function createSharePointSendContext(params: { conversationId: string; siteId: string }) {
  return {
    app: { id: "sharepoint-app" },
    appId: "app-id",
    conversationId: params.conversationId,
    ref: {},
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    conversationType: "groupChat" as const,
    replyStyle: "top-level" as const,
    sdkCloudOptions: { cloud: "Public" as const },
    tokenProvider: { getAccessToken: vi.fn(async () => "token") },
    mediaMaxBytes: 8 * 1024 * 1024,
    sharePointSiteId: params.siteId,
  };
}

function mockSharePointPdfUpload(params: {
  bufferSize: number;
  fileName: string;
  itemId: string;
  uniqueId: string;
}) {
  mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
    buffer: Buffer.alloc(params.bufferSize, "pdf"),
    contentType: "application/pdf",
    fileName: params.fileName,
    kind: "file",
  });
  mockState.requiresFileConsent.mockReturnValue(false);
  mockState.uploadAndShareSharePoint.mockResolvedValue({
    itemId: params.itemId,
    webUrl: `https://sp.example.com/${params.fileName}`,
    shareUrl: `https://sp.example.com/share/${params.fileName}`,
    name: params.fileName,
  });
  mockState.getDriveItemProperties.mockResolvedValue({
    eTag: `"${params.uniqueId},1"`,
    webDavUrl: `https://sp.example.com/dav/${params.fileName}`,
    name: params.fileName,
  });
  mockState.buildTeamsFileInfoCard.mockReturnValue({
    contentType: "application/vnd.microsoft.teams.card.file.info",
    contentUrl: `https://sp.example.com/dav/${params.fileName}`,
    name: params.fileName,
    content: { uniqueId: params.uniqueId, fileType: "pdf" },
  });
}

async function useActualOutboundMediaLoader() {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
    "openclaw/plugin-sdk/outbound-media",
  );
  mockState.loadOutboundMediaFromUrl.mockImplementation(actual.loadOutboundMediaFromUrl);
}

describe("sendMessageMSTeams", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockState)) {
      mock.mockReset();
    }
    mockState.resolveMarkdownTableMode.mockReturnValue("off");
    mockState.convertMarkdownTables.mockImplementation((text) => text);
    mockState.runtimeResolveMarkdownTableMode.mockReturnValue("off");
    mockState.runtimeConvertMarkdownTables.mockImplementation((text) => text);
    mockState.setPendingUploadActivityIdFs.mockResolvedValue(undefined);
    mockState.extractFilename.mockResolvedValue("fallback.bin");
    mockState.requiresFileConsent.mockReturnValue(false);
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      app: { id: "send-app" },
      appId: "app-id",
      conversationId,
      ref: {},
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "personal",
      replyStyle: "top-level",
      sdkCloudOptions: { cloud: "Public" },
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
      mediaMaxBytes: 8 * 1024,
      sharePointSiteId: undefined,
    });
    mockState.sendMSTeamsMessages.mockResolvedValue(["message-1"]);
    mockState.sendMSTeamsActivityWithReference.mockResolvedValue({ id: "message-1" });
    mockState.updateMSTeamsActivityWithReference.mockResolvedValue({ id: "updated" });
    mockState.deleteMSTeamsActivityWithReference.mockResolvedValue(undefined);
  });

  it.each(["success", "observer failure", "persistence failure"] as const)(
    "settles an accepted consent card after %s",
    async (outcome) => {
      const failure = new Error(outcome);
      mockState.loadOutboundMediaFromUrl.mockResolvedValue({
        buffer: Buffer.from("file contents"),
        contentType: "application/pdf",
        fileName: "report.pdf",
        kind: "file",
      });
      mockState.requiresFileConsent.mockReturnValue(true);
      mockState.prepareFileConsentActivityFs.mockResolvedValue({
        activity: { type: "message", attachments: [] },
        uploadId: "pending-file",
      });
      if (outcome === "persistence failure") {
        mockState.setPendingUploadActivityIdFs.mockRejectedValue(failure);
      }
      const onDeliveryResult = vi.fn(async (result) => {
        expect(result).toMatchObject({ messageId: "message-1", pendingUploadId: "pending-file" });
        if (outcome === "observer failure") {
          throw failure;
        }
      });

      const send = sendMessageMSTeams({
        ...destination,
        text: "report",
        mediaUrl: "file:///tmp/report.pdf",
        onDeliveryResult,
      });
      if (outcome === "success") {
        await expect(send).resolves.toMatchObject({
          messageId: "message-1",
          pendingUploadId: "pending-file",
        });
      } else {
        await expect(send).rejects.toMatchObject({
          cause: failure,
          code: "CHANNEL_PARTIAL_DELIVERY",
          deliveryResult: {
            visibleReplySent: true,
            receipt: {
              platformMessageIds: ["message-1"],
              parts: [expect.objectContaining({ kind: "card" })],
            },
          },
        });
      }
      expect(mockState.sendMSTeamsActivityWithReference).toHaveBeenCalledOnce();
      expect(onDeliveryResult).toHaveBeenCalledOnce();
      // The existing pending-upload tests cover storage; this guards the sender's
      // obligation to finish that write even when its receipt observer rejects.
      expect(mockState.setPendingUploadActivityIdFs).toHaveBeenCalledExactlyOnceWith(
        "pending-file",
        "message-1",
      );
      expect(onDeliveryResult.mock.invocationCallOrder[0]).toBeLessThan(
        mockState.setPendingUploadActivityIdFs.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("loads workspace-relative media through the trusted host reader", async () => {
    const workspaceDir = await realpath(
      await mkdtemp(join(tmpdir(), "openclaw-msteams-workspace-")),
    );
    const filePath = join(workspaceDir, "report.txt");
    const fileContents = Buffer.from("approved Teams attachment");
    const approvedReader = vi.fn(async (candidate: string) => await readFile(candidate));
    const conflictingReader = vi.fn(async () => Buffer.from("forged Teams attachment"));
    const mediaAccess = {
      localRoots: [workspaceDir],
      workspaceDir,
      readFile: approvedReader,
    };

    try {
      await writeFile(filePath, fileContents);
      await useActualOutboundMediaLoader();

      await sendMessageMSTeams({
        ...destination,
        text: "approved attachment",
        mediaUrl: "report.txt",
        mediaAccess,
        mediaLocalRoots: [join(workspaceDir, "unapproved")],
        mediaReadFile: conflictingReader,
      });

      expect(mockState.loadOutboundMediaFromUrl.mock.calls[0]?.[1]?.mediaAccess).toBe(mediaAccess);
      expect(conflictingReader).not.toHaveBeenCalled();
      expect(approvedReader).toHaveBeenCalledWith(filePath);
      expect(mockState.sendMSTeamsMessages.mock.calls[0]?.[0].messages[1]?.mediaUrl).toBe(
        `data:text/plain;base64,${fileContents.toString("base64")}`,
      );
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects workspace-relative attachments outside host-approved roots", async () => {
    const sandbox = await realpath(await mkdtemp(join(tmpdir(), "openclaw-msteams-roots-")));
    const workspaceDir = join(sandbox, "workspace");
    const approvedReader = vi.fn(async (candidate: string) => await readFile(candidate));

    try {
      await mkdir(workspaceDir);
      await writeFile(join(sandbox, "outside.txt"), "outside approved workspace");
      await useActualOutboundMediaLoader();

      await expect(
        sendMessageMSTeams({
          ...destination,
          text: "outside attachment",
          mediaUrl: "../outside.txt",
          mediaAccess: { localRoots: [workspaceDir], workspaceDir, readFile: approvedReader },
        }),
      ).rejects.toThrow("Local media path is not under an allowed directory");
      expect(approvedReader).not.toHaveBeenCalled();
      expect(mockState.sendMSTeamsMessages).not.toHaveBeenCalled();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects a host media reader that has no approved local roots", async () => {
    const approvedReader = vi.fn(async () => Buffer.from("private attachment"));
    await useActualOutboundMediaLoader();

    await expect(
      sendMessageMSTeams({
        ...destination,
        text: "private attachment",
        mediaUrl: "report.txt",
        mediaAccess: { workspaceDir: "/approved/workspace", readFile: approvedReader },
      }),
    ).rejects.toThrow("Host media read requires explicit localRoots");
    expect(approvedReader).not.toHaveBeenCalled();
    expect(mockState.sendMSTeamsMessages).not.toHaveBeenCalled();
  });

  it("uses the Graph-native group conversation ID for SharePoint sharing", async () => {
    const graphConversationId = "19:group-id@thread.v2";

    mockState.resolveMSTeamsSendContext.mockResolvedValue(
      createSharePointSendContext({ conversationId: graphConversationId, siteId: "site-456" }),
    );
    mockSharePointPdfUpload({
      bufferSize: 50,
      fileName: "report.pdf",
      itemId: "item-2",
      uniqueId: "{GUID-456}",
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: `conversation:${graphConversationId}`,
      text: "report",
      mediaUrl: "https://example.com/report.pdf",
    });

    expect(mockState.uploadAndShareSharePoint).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ chatId: graphConversationId, siteId: "site-456" }),
    );
  });

  it("fails clearly when a group file has no SharePoint site", async () => {
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      ...createSharePointSendContext({ conversationId: "19:group-id@thread.v2", siteId: "unused" }),
      sharePointSiteId: undefined,
    });
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("pdf"),
      contentType: "application/pdf",
      fileName: "report.pdf",
      kind: "file",
    });

    await expect(
      sendMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: "conversation:19:group-id@thread.v2",
        text: "report",
        mediaUrl: "https://example.com/report.pdf",
      }),
    ).rejects.toThrow("channels.msteams.sharePointSiteId is required");
    expect(mockState.uploadAndShareSharePoint).not.toHaveBeenCalled();
  });
});

describe("editMessageMSTeams", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    mockState.resolveMarkdownTableMode.mockReset().mockReturnValue("off");
    mockState.convertMarkdownTables.mockReset().mockImplementation((text) => text);
  });

  beforeEach(() => {
    mockState.resolveMSTeamsSendContext.mockReset();
    mockState.updateMSTeamsActivityWithReference.mockReset();
    mockState.updateMSTeamsActivityWithReference.mockResolvedValue({ id: "updated" });
  });

  it("applies the default account table policy to edited activities", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: { id: "msteams", meta: { id: "msteams" } },
        },
      ]),
    );
    const markdown = await vi.importActual<
      typeof import("openclaw/plugin-sdk/markdown-table-runtime")
    >("openclaw/plugin-sdk/markdown-table-runtime");
    const text = await vi.importActual<typeof import("openclaw/plugin-sdk/text-chunking")>(
      "openclaw/plugin-sdk/text-chunking",
    );
    mockState.resolveMarkdownTableMode.mockImplementation(markdown.resolveMarkdownTableMode);
    mockState.convertMarkdownTables.mockImplementation(text.convertMarkdownTables);
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      app: {},
      conversationId,
      ref: { conversation: { id: conversationId } },
      log: { debug: vi.fn(), info: vi.fn() },
      sdkCloudOptions: { cloud: "Public" },
    });
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          defaultAccount: "support",
          markdown: { tables: "off" },
          accounts: {
            support: { markdown: { tables: "bullets" } },
          },
        },
      },
    };
    await editMessageMSTeams({
      cfg,
      accountId: undefined,
      to: destination.to,
      activityId: "edited-message",
      text: "| Name | Status |\n| --- | --- |\n| Widget | Ready |",
    });
    const activity = mockState.updateMSTeamsActivityWithReference.mock.calls[0]?.[3];
    expect(activity).toMatchObject({ type: "message", id: "edited-message" });
    expect(activity).toMatchObject({ text: expect.stringContaining("Widget") });
    expect(activity).toMatchObject({ text: expect.stringContaining("Status: Ready") });
    expect(activity).not.toMatchObject({ text: expect.stringContaining("| Name |") });
  });

  it("updates an existing activity with a replacement Adaptive Card", async () => {
    const mockApp = { id: "adaptive-card-app" };
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      app: mockApp,
      conversationId,
      ref: { conversation: { id: conversationId } },
      log: { debug: vi.fn(), info: vi.fn() },
      sdkCloudOptions: { cloud: "Public" },
    });
    const card = { type: "AdaptiveCard", version: "1.5", body: [] };

    const result = await editAdaptiveCardMSTeams({
      ...destination,
      activityId: "approval-activity",
      card,
    });

    expect(result.conversationId).toBe(conversationId);
    expect(mockState.updateMSTeamsActivityWithReference).toHaveBeenCalledWith(
      mockApp,
      expect.objectContaining({ conversation: { id: conversationId } }),
      "approval-activity",
      {
        type: "message",
        id: "approval-activity",
        attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
      },
      { serviceUrlBoundary: { cloud: "Public" } },
    );
  });
});

describe("deleteMessageMSTeams", () => {
  beforeEach(() => {
    mockState.resolveMSTeamsSendContext.mockReset();
    mockState.deleteMSTeamsActivityWithReference.mockReset();
    mockState.deleteMSTeamsActivityWithReference.mockResolvedValue(undefined);
  });

  it("deletes with the resolved Teams conversation reference", async () => {
    const mockApp = { id: "delete-app" };
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      app: mockApp,
      appId: "app-id",
      conversationId,
      ref: {
        user: { id: "user-1" },
        agent: { id: "agent-1" },
        conversation: { id: conversationId, conversationType: "groupChat" },
        channelId: "msteams",
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "groupChat",
      sdkCloudOptions: { cloud: "Public" },
      tokenProvider: {},
    });

    const result = await deleteMessageMSTeams({
      ...destination,
      activityId: "activity-456",
    });

    expect(result.conversationId).toBe(conversationId);

    expect(mockState.deleteMSTeamsActivityWithReference).toHaveBeenCalledWith(
      mockApp,
      expect.objectContaining({
        conversation: { id: conversationId, conversationType: "groupChat" },
        serviceUrl: "https://service.example.com",
      }),
      "activity-456",
      { serviceUrlBoundary: { cloud: "Public" } },
    );
  });

  it("throws a descriptive error when delete fails", async () => {
    mockProactiveSendContextFailure("Not found");

    await expect(
      deleteMessageMSTeams({
        ...destination,
        activityId: "activity-456",
      }),
    ).rejects.toThrow("msteams delete failed");
  });
});
