import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerMSTeamsHandlers
} from "./monitor-handler.js";
import { clearPendingUploads, getPendingUpload, storePendingUpload } from "./pending-uploads.js";
import { setMSTeamsRuntime } from "./runtime.js";
const fileConsentMockState = vi.hoisted(() => ({
  uploadToConsentUrl: vi.fn()
}));
vi.mock("./file-consent.js", async () => {
  const actual = await vi.importActual("./file-consent.js");
  return {
    ...actual,
    uploadToConsentUrl: fileConsentMockState.uploadToConsentUrl
  };
});
const runtimeStub = {
  logging: {
    shouldLogVerbose: () => false
  },
  channel: {
    debounce: {
      resolveInboundDebounceMs: () => 0,
      createInboundDebouncer: () => ({
        enqueue: async () => {
        }
      })
    }
  }
};
function createDeps() {
  const adapter = {
    continueConversation: async () => {
    },
    process: async () => {
    }
  };
  const conversationStore = {
    upsert: async () => {
    },
    get: async () => null,
    list: async () => [],
    remove: async () => false,
    findByUserId: async () => null
  };
  const pollStore = {
    createPoll: async () => {
    },
    getPoll: async () => null,
    recordVote: async () => null
  };
  return {
    cfg: {},
    runtime: {
      error: vi.fn()
    },
    appId: "test-app-id",
    adapter,
    tokenProvider: {
      getAccessToken: async () => "token"
    },
    textLimit: 4e3,
    mediaMaxBytes: 8 * 1024 * 1024,
    conversationStore,
    pollStore,
    log: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }
  };
}
function createActivityHandler() {
  let handler;
  handler = {
    onMessage: () => handler,
    onMembersAdded: () => handler,
    run: async () => {
    }
  };
  return handler;
}
function createInvokeContext(params) {
  const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
  const uploadInfo = params.action === "accept" ? {
    name: "secret.txt",
    uploadUrl: "https://upload.example.com/put",
    contentUrl: "https://content.example.com/file",
    uniqueId: "unique-id",
    fileType: "txt"
  } : void 0;
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
          context: { uploadId: params.uploadId }
        }
      },
      sendActivity,
      sendActivities: async () => []
    },
    sendActivity
  };
}
function createConsentInvokeHarness(params) {
  const uploadId = storePendingUpload({
    buffer: Buffer.from("TOP_SECRET_VICTIM_FILE\n"),
    filename: "secret.txt",
    contentType: "text/plain",
    conversationId: params.pendingConversationId ?? "19:victim@thread.v2"
  });
  const handler = registerMSTeamsHandlers(createActivityHandler(), createDeps());
  const { context, sendActivity } = createInvokeContext({
    conversationId: params.invokeConversationId,
    uploadId,
    action: params.action
  });
  return { uploadId, handler, context, sendActivity };
}
describe("msteams file consent invoke authz", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
    clearPendingUploads();
    fileConsentMockState.uploadToConsentUrl.mockReset();
    fileConsentMockState.uploadToConsentUrl.mockResolvedValue(void 0);
  });
  it("uploads when invoke conversation matches pending upload conversation", async () => {
    const { uploadId, handler, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept"
    });
    await handler.run?.(context);
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse"
      })
    );
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://upload.example.com/put"
      })
    );
    expect(getPendingUpload(uploadId)).toBeUndefined();
  });
  it("rejects cross-conversation accept invoke and keeps pending upload", async () => {
    const { uploadId, handler, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:attacker@thread.v2",
      action: "accept"
    });
    await handler.run?.(context);
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse"
      })
    );
    expect(sendActivity).toHaveBeenCalledWith(
      "The file upload request has expired. Please try sending the file again."
    );
    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(getPendingUpload(uploadId)).toBeDefined();
  });
  it("ignores cross-conversation decline invoke and keeps pending upload", async () => {
    const { uploadId, handler, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:attacker@thread.v2",
      action: "decline"
    });
    await handler.run?.(context);
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse"
      })
    );
    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(getPendingUpload(uploadId)).toBeDefined();
    expect(sendActivity).toHaveBeenCalledTimes(1);
  });
});
