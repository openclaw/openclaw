import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { StoredConversationReference } from "./conversation-store.js";
import type { MSTeamsProactiveContext } from "./send-context.js";
import {
  deleteMessageMSTeams,
  editAdaptiveCardMSTeams,
  editMessageMSTeams,
  sendMessageMSTeams,
} from "./send.js";
import { createMSTeamsTestConfig } from "./setup.test-support.js";

const mockState = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  resolveMSTeamsSendContext: vi.fn(),
  resolveMarkdownTableMode: vi.fn<
    typeof import("openclaw/plugin-sdk/markdown-table-runtime").resolveMarkdownTableMode
  >(() => "off"),
  convertMarkdownTables: vi.fn<
    typeof import("openclaw/plugin-sdk/text-chunking").convertMarkdownTables
  >((text) => text),
  requiresFileConsent: vi.fn(),
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
}));

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

// mock-isolation: capture outbound messages without opening a live Teams transport.
vi.mock("./messenger.js", () => ({
  sendMSTeamsMessages: mockState.sendMSTeamsMessages,
  buildConversationReference: ({
    serviceUrl = "https://service.example.com",
    conversation = { id: "19:conversation@thread.tacv2" },
    agent,
    user,
    tenantId,
    aadObjectId,
  }: StoredConversationReference) => ({
    serviceUrl,
    conversation,
    agent,
    user,
    tenantId,
    aadObjectId,
  }),
}));

vi.mock("./graph-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph-upload.js")>();
  return {
    ...actual,
    uploadAndShareSharePoint: mockState.uploadAndShareSharePoint,
  };
});

vi.mock("./sdk-proactive.js", () => ({
  sendMSTeamsActivityWithReference: mockState.sendMSTeamsActivityWithReference,
  updateMSTeamsActivityWithReference: mockState.updateMSTeamsActivityWithReference,
  deleteMSTeamsActivityWithReference: mockState.deleteMSTeamsActivityWithReference,
}));

const conversationId = "19:conversation@thread.tacv2";
const destination = { cfg: {}, to: `conversation:${conversationId}` };

function mockContext(
  overrides: Partial<Omit<MSTeamsProactiveContext, "app">> & { app?: object } = {},
) {
  const context = {
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
    ...overrides,
  };
  mockState.resolveMSTeamsSendContext.mockResolvedValue(context);
}

function mockPdf() {
  mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
    buffer: Buffer.from("pdf"),
    contentType: "application/pdf",
    fileName: "report.pdf",
    kind: "file",
  });
}

function sendFile(options: Partial<Parameters<typeof sendMessageMSTeams>[0]> = {}) {
  return sendMessageMSTeams({
    ...destination,
    text: "report",
    mediaUrl: "file:///tmp/report.pdf",
    ...options,
  });
}

async function useActualOutboundMediaLoader() {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
    "openclaw/plugin-sdk/outbound-media",
  );
  mockState.loadOutboundMediaFromUrl.mockImplementation(actual.loadOutboundMediaFromUrl);
}

beforeEach(() => {
  for (const mock of Object.values(mockState)) {
    mock.mockReset();
  }
  mockState.resolveMarkdownTableMode.mockReturnValue("off");
  mockState.convertMarkdownTables.mockImplementation((text) => text);
  mockState.setPendingUploadActivityIdFs.mockResolvedValue(undefined);
  mockState.extractFilename.mockResolvedValue("fallback.bin");
  mockState.requiresFileConsent.mockReturnValue(false);
  mockContext();
  mockState.sendMSTeamsMessages.mockResolvedValue(["message-1"]);
  mockState.sendMSTeamsActivityWithReference.mockResolvedValue({ id: "message-1" });
  mockState.updateMSTeamsActivityWithReference.mockResolvedValue({ id: "updated" });
  mockState.deleteMSTeamsActivityWithReference.mockResolvedValue(undefined);
});

describe("sendMessageMSTeams", () => {
  it.each(["success", "observer failure", "persistence failure"] as const)(
    "settles an accepted consent card after %s",
    async (outcome) => {
      const failure = new Error(outcome);
      mockPdf();
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

      const send = sendFile({ onDeliveryResult });
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
      expect(mockState.setPendingUploadActivityIdFs).toHaveBeenCalledExactlyOnceWith(
        "pending-file",
        "message-1",
      );
      expect(onDeliveryResult.mock.invocationCallOrder[0]).toBeLessThan(
        mockState.setPendingUploadActivityIdFs.mock.invocationCallOrder[0]!,
      );
    },
  );

  it.each([
    [
      "outside approved roots",
      "../outside.txt",
      true,
      "Local media path is not under an allowed directory",
    ],
    ["without approved roots", "report.txt", false, "Host media read requires explicit localRoots"],
  ] as const)("rejects host media %s", async (_label, mediaUrl, hasRoots, error) => {
    await withTempDir("openclaw-msteams-roots-", async (dir) => {
      const sandbox = await realpath(dir);
      const workspaceDir = join(sandbox, "workspace");
      const approvedReader = vi.fn(async (candidate: string) => await readFile(candidate));
      await mkdir(workspaceDir);
      await writeFile(join(sandbox, "outside.txt"), "outside approved workspace");
      await useActualOutboundMediaLoader();
      await expect(
        sendFile({
          mediaUrl,
          mediaAccess: {
            workspaceDir,
            readFile: approvedReader,
            ...(hasRoots ? { localRoots: [workspaceDir] } : {}),
          },
        }),
      ).rejects.toThrow(error);
      expect(approvedReader).not.toHaveBeenCalled();
      expect(mockState.sendMSTeamsMessages).not.toHaveBeenCalled();
    });
  });

  it("fails clearly when a group file has no SharePoint site", async () => {
    mockContext({
      conversationId: "19:group-id@thread.v2",
      conversationType: "groupChat",
      mediaMaxBytes: 8 * 1024 * 1024,
    });
    mockPdf();

    await expect(sendFile()).rejects.toThrow("channels.msteams.sharePointSiteId is required");
    expect(mockState.uploadAndShareSharePoint).not.toHaveBeenCalled();
  });
});

describe("editMessageMSTeams", () => {
  afterEach(resetPluginRuntimeStateForTest);

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
    mockContext({ app: {}, ref: { conversation: { id: conversationId } } });
    const cfg: OpenClawConfig = createMSTeamsTestConfig({
      defaultAccount: "support",
      markdown: { tables: "off" },
      accounts: { support: { markdown: { tables: "bullets" } } },
    });
    await editMessageMSTeams({
      cfg,
      accountId: undefined,
      to: destination.to,
      activityId: "edited-message",
      text: "| Name | Status |\n| --- | --- |\n| Widget | Ready |",
    });
    const activity = mockState.updateMSTeamsActivityWithReference.mock.calls[0]?.[3];
    expect(activity).toMatchObject({
      type: "message",
      id: "edited-message",
      text: expect.stringContaining("Widget"),
    });
    expect(activity).toMatchObject({ text: expect.stringContaining("Status: Ready") });
    expect(activity).not.toMatchObject({ text: expect.stringContaining("| Name |") });
  });

  it("updates an existing activity with a replacement Adaptive Card", async () => {
    const mockApp = { id: "adaptive-card-app" };
    mockContext({ app: mockApp, ref: { conversation: { id: conversationId } } });
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
  it.each([false, true])("deletes with the resolved reference (failure=%s)", async (fails) => {
    const mockApp = { id: "delete-app" };
    mockContext({
      app: mockApp,
      conversationType: "groupChat",
      ref: {
        user: { id: "user-1" },
        agent: { id: "agent-1" },
        conversation: { id: conversationId, conversationType: "groupChat" },
        channelId: "msteams",
      },
    });

    if (fails) {
      mockState.deleteMSTeamsActivityWithReference.mockRejectedValue(new Error("Not found"));
    }
    const result = deleteMessageMSTeams({ ...destination, activityId: "activity-456" });
    if (fails) {
      await expect(result).rejects.toThrow("msteams delete failed");
    } else {
      await expect(result).resolves.toEqual({ conversationId });
    }
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
});
