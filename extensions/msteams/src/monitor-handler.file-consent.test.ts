import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import {
  createActivityHandler,
  createMSTeamsMessageHandlerDeps,
} from "./monitor-handler.test-helpers.js";
import { clearPendingUploads, getPendingUpload, storePendingUpload } from "./pending-uploads.js";
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
  return createMSTeamsMessageHandlerDeps({
    cfg: {} as OpenClawConfig,
    runtime: {
      error: vi.fn(),
    } as unknown as RuntimeEnv,
  });
}

function createInvokeContext(params: {
  conversationId: string;
  uploadId: string;
  action: "accept" | "decline";
}): {
  context: MSTeamsTurnContext;
  sendActivity: ReturnType<typeof vi.fn>;
  updateActivity: ReturnType<typeof vi.fn>;
} {
  const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
  const updateActivity = vi.fn(async () => ({ id: "activity-id" }));
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
  consentCardActivityId?: string;
}) {
  const uploadId = storePendingUpload({
    buffer: Buffer.from("TOP_SECRET_VICTIM_FILE\n"),
    filename: "secret.txt",
    contentType: "text/plain",
    conversationId: params.pendingConversationId ?? "19:victim@thread.v2",
    consentCardActivityId: params.consentCardActivityId,
  });
  const handler = registerMSTeamsHandlers(
    createActivityHandler(),
    createDeps(),
  ) as MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  const { context, sendActivity, updateActivity } = createInvokeContext({
    conversationId: params.invokeConversationId,
    uploadId,
    action: params.action,
  });
  return { uploadId, handler, context, sendActivity, updateActivity };
}

function requirePendingUpload(uploadId: string) {
  const upload = getPendingUpload(uploadId);
  if (!upload) {
    throw new Error(`expected pending upload ${uploadId}`);
  }
  return upload;
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

    await handler.run(context);

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

  it("calls updateActivity to replace the consent card when consentCardActivityId is set", async () => {
    const { handler, context, sendActivity, updateActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      consentCardActivityId: "consent-card-activity-id-123",
    });

    await handler.run?.(context);

    expect(sendActivity).toHaveBeenCalledWith(expect.objectContaining({ type: "invokeResponse" }));
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);

    // Should replace the original consent card with the file info card
    expect(updateActivity).toHaveBeenCalledTimes(1);
    expect(updateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "consent-card-activity-id-123",
        type: "message",
        attachments: expect.arrayContaining([
          expect.objectContaining({
            contentType: "application/vnd.microsoft.teams.card.file.info",
          }),
        ]),
      }),
    );
  });

  it("does not send file info card via sendActivity when updateActivity succeeds", async () => {
    const { handler, context, sendActivity, updateActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      consentCardActivityId: "consent-card-activity-id-happy",
    });

    await handler.run?.(context);

    // updateActivity should replace the consent card in-place
    expect(updateActivity).toHaveBeenCalledTimes(1);

    // sendActivity should only be called once for the invokeResponse, NOT for the file info card
    expect(sendActivity).toHaveBeenCalledTimes(1);
    expect(sendActivity).toHaveBeenCalledWith(expect.objectContaining({ type: "invokeResponse" }));

    // Explicitly verify no file info card was sent via sendActivity
    for (const call of sendActivity.mock.calls) {
      const arg = call[0] as Record<string, unknown>;
      if (typeof arg === "object" && arg !== null && "attachments" in arg) {
        const attachments = arg.attachments as Array<{ contentType?: string }>;
        for (const att of attachments) {
          expect(att.contentType).not.toBe("application/vnd.microsoft.teams.card.file.info");
        }
      }
    }
  });

  it("does not call updateActivity when no consentCardActivityId is stored", async () => {
    const { handler, context, updateActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      // no consentCardActivityId
    });

    await handler.run?.(context);

    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
    expect(updateActivity).not.toHaveBeenCalled();
  });

  it("still completes upload if updateActivity throws", async () => {
    const { uploadId, handler, context, updateActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      consentCardActivityId: "consent-card-activity-id-fail",
    });
    updateActivity.mockRejectedValueOnce(new Error("Teams API error"));

    await handler.run?.(context);

    // Upload should have completed despite updateActivity failure
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
    expect(getPendingUpload(uploadId)).toBeUndefined();
    expect(updateActivity).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-conversation accept invoke and keeps pending upload", async () => {
    const { uploadId, handler, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:attacker@thread.v2",
      action: "accept",
    });

    await handler.run(context);

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
    expect(requirePendingUpload(uploadId)).toMatchObject({
      conversationId: "19:victim@thread.v2",
      filename: "secret.txt",
      contentType: "text/plain",
    });
  });

  it("ignores cross-conversation decline invoke and keeps pending upload", async () => {
    const { uploadId, handler, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:attacker@thread.v2",
      action: "decline",
    });

    await handler.run(context);

    // invokeResponse should be sent immediately
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
      }),
    );

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(requirePendingUpload(uploadId)).toMatchObject({
      conversationId: "19:victim@thread.v2",
      filename: "secret.txt",
      contentType: "text/plain",
    });
    expect(sendActivity).toHaveBeenCalledTimes(1);
  });
});
