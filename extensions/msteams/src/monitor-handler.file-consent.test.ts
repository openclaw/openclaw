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

function createDeps() {
  const proactiveSendActivity = vi.fn(async () => ({ id: "proactive-activity-id" }));
  const adapter: MSTeamsAdapter = {
    continueConversation: async (_appId, _ref, logic) => {
      await logic({ sendActivity: proactiveSendActivity });
    },
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
  const deps: MSTeamsMessageHandlerDeps = {
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
  return { deps, proactiveSendActivity };
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
}): { context: MSTeamsTurnContext; sendActivity: ReturnType<typeof vi.fn> } {
  const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
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
    } as unknown as MSTeamsTurnContext,
    sendActivity,
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
  const { deps, proactiveSendActivity } = createDeps();
  const handler = registerMSTeamsHandlers(createActivityHandler(), deps);
  const { context, sendActivity } = createInvokeContext({
    conversationId: params.invokeConversationId,
    uploadId,
    action: params.action,
  });
  return { uploadId, handler, context, sendActivity, proactiveSendActivity };
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

  it("rejects cross-conversation accept invoke and keeps pending upload", async () => {
    const { uploadId, handler, context, sendActivity, proactiveSendActivity } =
      createConsentInvokeHarness({
        invokeConversationId: "19:attacker@thread.v2",
        action: "accept",
      });

    await handler.run?.(context);

    // invokeResponse should be sent immediately via the turn context
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
      }),
    );

    // Expired message sent via proactive messaging (turn context is revoked)
    expect(proactiveSendActivity).toHaveBeenCalledWith(
      "The file upload request has expired. Please try sending the file again.",
    );

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(getPendingUpload(uploadId)).toBeDefined();
  });

  it("ignores cross-conversation decline invoke and keeps pending upload", async () => {
    const { uploadId, handler, context, sendActivity, proactiveSendActivity } =
      createConsentInvokeHarness({
        invokeConversationId: "19:attacker@thread.v2",
        action: "decline",
      });

    await handler.run?.(context);

    // invokeResponse should be sent immediately via the turn context
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
      }),
    );

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(getPendingUpload(uploadId)).toBeDefined();
    // Only the invoke response should be sent via the turn context
    expect(sendActivity).toHaveBeenCalledTimes(1);
    // No proactive messages for decline
    expect(proactiveSendActivity).not.toHaveBeenCalled();
  });
});
