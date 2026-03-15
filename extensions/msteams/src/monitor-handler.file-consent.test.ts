import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/msteams";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsAdapter } from "./messenger.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import { clearPendingUploads, getPendingUpload, storePendingUpload } from "./pending-uploads.js";
import type { MSTeamsPollStore } from "./polls.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const fileConsentMockState = vi.hoisted(() => ({
  uploadToConsentUrl: vi.fn(),
}));

vi.mock("./file-consent.js", async () => {
  const actual = await vi.importActual<typeof import("./file-consent.js")>("./file-consent.js");
  return {
    ...actual,
    uploadToConsentUrl: fileConsentMockState.uploadToConsentUrl,
  };
});

const runtimeStub: PluginRuntime = {
  logging: {
    shouldLogVerbose: () => false,
  },
  channel: {
    debounce: {
      resolveInboundDebounceMs: () => 0,
      createInboundDebouncer: () => ({
        enqueue: async () => {},
      }),
    },
  },
} as unknown as PluginRuntime;

function createDeps(): MSTeamsMessageHandlerDeps {
  const adapter: MSTeamsAdapter = {
    continueConversation: async () => {},
    process: async () => {},
  };
  const conversationStore: MSTeamsConversationStore = {
    upsert: async () => {},
    get: async () => null,
    list: async () => [],
    remove: async () => false,
    findByUserId: async () => null,
  };
  const pollStore: MSTeamsPollStore = {
    createPoll: async () => {},
    getPoll: async () => null,
    recordVote: async () => null,
  };
  return {
    cfg: {} as OpenClawConfig,
    runtime: {
      error: vi.fn(),
    } as unknown as RuntimeEnv,
    appId: "test-app-id",
    adapter,
    tokenProvider: {
      getAccessToken: async () => "token",
    },
    textLimit: 4000,
    mediaMaxBytes: 8 * 1024 * 1024,
    conversationStore,
    pollStore,
    log: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createActivityHandler(): MSTeamsActivityHandler {
  let handler: MSTeamsActivityHandler;
  handler = {
    onMessage: () => handler,
    onMembersAdded: () => handler,
    run: async () => {},
  };
  return handler;
}

function createInvokeContext(params: {
  conversationId: string;
  uploadId: string;
  action: "accept" | "decline";
  replyToId?: string;
}): {
  context: MSTeamsTurnContext;
  sendActivity: ReturnType<typeof vi.fn>;
  updateActivity: ReturnType<typeof vi.fn>;
} {
  const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
  const updateActivity = vi.fn(async () => {});
  const uploadInfo =
    params.action === "accept"
      ? {
          name: "secret.txt",
          uploadUrl: "https://upload.example.com/put",
          contentUrl: "https://content.example.com/file",
          uniqueId: "unique-id",
          fileType: "txt",
        }
      : undefined;
  return {
    context: {
      activity: {
        type: "invoke",
        name: "fileConsent/invoke",
        conversation: { id: params.conversationId },
        replyToId: params.replyToId,
        value: {
          type: "fileUpload",
          action: params.action,
          uploadInfo,
          context: { uploadId: params.uploadId },
        },
      },
      sendActivity,
      sendActivities: async () => [],
      updateActivity,
    } as unknown as MSTeamsTurnContext,
    sendActivity,
    updateActivity,
  };
}

function createConsentInvokeHarness(params: {
  pendingConversationId?: string;
  invokeConversationId: string;
  action: "accept" | "decline";
}) {
  const uploadId = storePendingUpload({
    buffer: Buffer.from("TOP_SECRET_VICTIM_FILE\n"),
    filename: "secret.txt",
    contentType: "text/plain",
    conversationId: params.pendingConversationId ?? "19:victim@thread.v2",
  });
  const handler = registerMSTeamsHandlers(createActivityHandler(), createDeps());
  const { context, sendActivity } = createInvokeContext({
    conversationId: params.invokeConversationId,
    uploadId,
    action: params.action,
  });
  return { uploadId, handler, context, sendActivity };
}

describe("msteams file consent invoke authz", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
    clearPendingUploads();
    fileConsentMockState.uploadToConsentUrl.mockReset();
    fileConsentMockState.uploadToConsentUrl.mockResolvedValue(undefined);
  });

  it("uploads when invoke conversation matches pending upload conversation", async () => {
    const { uploadId, handler, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
    });

    await handler.run?.(context);

    // invokeResponse should be sent immediately
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
      }),
    );

    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);

    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://upload.example.com/put",
      }),
    );
    expect(getPendingUpload(uploadId)).toBeUndefined();
  });

  it("updates consent card in-place via updateActivity when replyToId is present", async () => {
    const uploadId = storePendingUpload({
      buffer: Buffer.from("file content"),
      filename: "report.pdf",
      contentType: "application/pdf",
      conversationId: "19:user@thread.v2",
    });
    const deps = createDeps();
    const handler = registerMSTeamsHandlers(createActivityHandler(), deps);
    const { context, sendActivity, updateActivity } = createInvokeContext({
      conversationId: "19:user@thread.v2;messageid=abc123",
      uploadId,
      action: "accept",
      replyToId: "consent-card-activity-id",
    });

    await handler.run?.(context);

    // Should update the original consent card in-place
    expect(updateActivity).toHaveBeenCalledTimes(1);
    expect(updateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "consent-card-activity-id",
        type: "message",
        attachments: [
          expect.objectContaining({
            contentType: "application/vnd.microsoft.teams.card.file.info",
            name: "secret.txt",
          }),
        ],
      }),
    );

    // Should NOT send FileInfoCard as a new message
    const fileInfoCalls = sendActivity.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "attachments" in (call[0] as Record<string, unknown>),
    );
    expect(fileInfoCalls).toHaveLength(0);
  });

  it("falls back to sendActivity when updateActivity fails", async () => {
    const uploadId = storePendingUpload({
      buffer: Buffer.from("file content"),
      filename: "report.pdf",
      contentType: "application/pdf",
      conversationId: "19:user@thread.v2",
    });
    const deps = createDeps();
    const handler = registerMSTeamsHandlers(createActivityHandler(), deps);
    const { context, sendActivity, updateActivity } = createInvokeContext({
      conversationId: "19:user@thread.v2;messageid=abc123",
      uploadId,
      action: "accept",
      replyToId: "consent-card-activity-id",
    });

    // Simulate updateActivity failure
    updateActivity.mockRejectedValueOnce(new Error("Activity not found"));

    await handler.run?.(context);

    // Should have attempted updateActivity
    expect(updateActivity).toHaveBeenCalledTimes(1);

    // Should fall back to sending FileInfoCard as a new message
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        attachments: [
          expect.objectContaining({
            contentType: "application/vnd.microsoft.teams.card.file.info",
          }),
        ],
      }),
    );
  });

  it("sends FileInfoCard as new message when replyToId is not present", async () => {
    const uploadId = storePendingUpload({
      buffer: Buffer.from("file content"),
      filename: "report.pdf",
      contentType: "application/pdf",
      conversationId: "19:user@thread.v2",
    });
    const deps = createDeps();
    const handler = registerMSTeamsHandlers(createActivityHandler(), deps);
    const { context, sendActivity, updateActivity } = createInvokeContext({
      conversationId: "19:user@thread.v2;messageid=abc123",
      uploadId,
      action: "accept",
      // No replyToId
    });

    await handler.run?.(context);

    // Should NOT call updateActivity
    expect(updateActivity).not.toHaveBeenCalled();

    // Should send FileInfoCard as a new message (fallback path)
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        attachments: [
          expect.objectContaining({
            contentType: "application/vnd.microsoft.teams.card.file.info",
          }),
        ],
      }),
    );
  });

  it("rejects cross-conversation accept invoke and keeps pending upload", async () => {
    const { uploadId, handler, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:attacker@thread.v2",
      action: "accept",
    });

    await handler.run?.(context);

    // invokeResponse should be sent immediately
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
      }),
    );

    expect(sendActivity).toHaveBeenCalledWith(
      "The file upload request has expired. Please try sending the file again.",
    );

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(getPendingUpload(uploadId)).toBeDefined();
  });

  it("ignores cross-conversation decline invoke and keeps pending upload", async () => {
    const { uploadId, handler, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:attacker@thread.v2",
      action: "decline",
    });

    await handler.run?.(context);

    // invokeResponse should be sent immediately
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
      }),
    );

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(getPendingUpload(uploadId)).toBeDefined();
    expect(sendActivity).toHaveBeenCalledTimes(1);
  });
});
