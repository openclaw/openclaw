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
  replyToId?: string;
}): {
  context: MSTeamsTurnContext;
  sendActivity: ReturnType<typeof vi.fn>;
  deleteActivity: ReturnType<typeof vi.fn>;
} {
  const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
  const deleteActivity = vi.fn(async () => {});
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
        replyToId: params.replyToId ?? "consent-card-activity-id",
        value: {
          type: "fileUpload",
          action: params.action,
          uploadInfo,
          context: { uploadId: params.uploadId },
        },
      },
      sendActivity,
      deleteActivity,
      sendActivities: async () => [],
    } as unknown as MSTeamsTurnContext,
    sendActivity,
    deleteActivity,
  };
}

function createConsentInvokeHarness(params: {
  pendingConversationId?: string;
  invokeConversationId: string;
  action: "accept" | "decline";
  replyToId?: string;
}) {
  const uploadId = storePendingUpload({
    buffer: Buffer.from("TOP_SECRET_VICTIM_FILE\n"),
    filename: "secret.txt",
    contentType: "text/plain",
    conversationId: params.pendingConversationId ?? "19:victim@thread.v2",
  });
  const handler = registerMSTeamsHandlers(
    createActivityHandler(),
    createDeps(),
  ) as MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  const { context, sendActivity, deleteActivity } = createInvokeContext({
    conversationId: params.invokeConversationId,
    uploadId,
    action: params.action,
    replyToId: params.replyToId,
  });
  return { uploadId, handler, context, sendActivity, deleteActivity };
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

describe("msteams file consent card cleanup", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
    clearPendingUploads();
    fileConsentMockState.uploadToConsentUrl.mockReset();
    fileConsentMockState.uploadToConsentUrl.mockResolvedValue(undefined);
  });

  it("deletes consent card after successful upload", async () => {
    const { handler, context, deleteActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      replyToId: "consent-msg-1",
    });

    await handler.run(context);

    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
    expect(deleteActivity).toHaveBeenCalledWith("consent-msg-1");
  });

  it("deletes consent card when user declines", async () => {
    const { handler, context, deleteActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "decline",
      replyToId: "consent-msg-2",
    });

    await handler.run(context);

    expect(deleteActivity).toHaveBeenCalledWith("consent-msg-2");
    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
  });

  it("deletes consent card when pending upload has expired", async () => {
    // Don't use harness — create context with unknown uploadId to simulate expiry
    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps(),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const { context, deleteActivity, sendActivity } = createInvokeContext({
      conversationId: "19:user@thread.v2",
      uploadId: "nonexistent-upload-id",
      action: "accept",
      replyToId: "consent-msg-3",
    });

    await handler.run(context);

    expect(deleteActivity).toHaveBeenCalledWith("consent-msg-3");
    expect(sendActivity).toHaveBeenCalledWith(
      "The file upload request has expired. Please try sending the file again.",
    );
  });

  it("deletes consent card when upload fails", async () => {
    fileConsentMockState.uploadToConsentUrl.mockRejectedValue(new Error("upload failed"));
    const { handler, context, deleteActivity, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      replyToId: "consent-msg-5",
    });

    await handler.run(context);

    expect(deleteActivity).toHaveBeenCalledWith("consent-msg-5");
    expect(sendActivity).toHaveBeenCalledWith(
      expect.stringContaining("File upload failed"),
    );
  });

  it("does not throw if deleteActivity fails", async () => {
    const { handler, context, deleteActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      replyToId: "consent-msg-4",
    });
    deleteActivity.mockRejectedValue(new Error("delete failed"));

    // Should not throw — deletion is best-effort
    await handler.run(context);

    expect(deleteActivity).toHaveBeenCalledWith("consent-msg-4");
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
  });
});
