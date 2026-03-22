import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
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

function mockCalledWithObjectPredicate(
  mockFn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  predicate: (arg: unknown) => boolean,
): boolean {
  return mockFn.mock.calls.some((call) => predicate(call[0]));
}

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
    updateActivity: async () => {},
    deleteActivity: async () => {},
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
    onReactionsAdded: () => handler,
    onReactionsRemoved: () => handler,
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
  const handler = registerMSTeamsHandlers(
    createActivityHandler(),
    createDeps(),
  ) as MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  const { context, sendActivity } = createInvokeContext({
    conversationId: params.invokeConversationId,
    uploadId,
    action: params.action,
  });
  return { uploadId, handler, context, sendActivity };
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
    const uploadMock = vi.mocked(fileConsentMockState.uploadToConsentUrl);
    uploadMock.mockReset();
    uploadMock.mockResolvedValue(undefined);
  });

  it("uploads when invoke conversation matches pending upload conversation", async () => {
    const { uploadId, handler, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
    });

    await handler.run(context);

    const send = vi.mocked(sendActivity);
    const uploadMock = vi.mocked(fileConsentMockState.uploadToConsentUrl);

    // invokeResponse should be sent immediately
    expect(
      mockCalledWithObjectPredicate(send, (arg) => {
        return (
          typeof arg === "object" &&
          arg !== null &&
          (arg as { type?: string }).type === "invokeResponse"
        );
      }),
    ).toBe(true);

    expect(uploadMock).toHaveBeenCalledTimes(1);

    expect(
      mockCalledWithObjectPredicate(uploadMock, (arg) => {
        return (
          typeof arg === "object" &&
          arg !== null &&
          (arg as { url?: string }).url === "https://upload.example.com/put"
        );
      }),
    ).toBe(true);
    expect(getPendingUpload(uploadId)).toBeUndefined();
  });

  it("rejects cross-conversation accept invoke and keeps pending upload", async () => {
    const { uploadId, handler, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:attacker@thread.v2",
      action: "accept",
    });

    await handler.run(context);

    const send = vi.mocked(sendActivity);
    const uploadMock = vi.mocked(fileConsentMockState.uploadToConsentUrl);

    // invokeResponse should be sent immediately
    expect(
      mockCalledWithObjectPredicate(send, (arg) => {
        return (
          typeof arg === "object" &&
          arg !== null &&
          (arg as { type?: string }).type === "invokeResponse"
        );
      }),
    ).toBe(true);

    expect(send).toHaveBeenCalledWith(
      "The file upload request has expired. Please try sending the file again.",
    );

    expect(uploadMock).not.toHaveBeenCalled();
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

    const send = vi.mocked(sendActivity);
    const uploadMock = vi.mocked(fileConsentMockState.uploadToConsentUrl);

    // invokeResponse should be sent immediately
    expect(
      mockCalledWithObjectPredicate(send, (arg) => {
        return (
          typeof arg === "object" &&
          arg !== null &&
          (arg as { type?: string }).type === "invokeResponse"
        );
      }),
    ).toBe(true);

    expect(uploadMock).not.toHaveBeenCalled();
    expect(requirePendingUpload(uploadId)).toMatchObject({
      conversationId: "19:victim@thread.v2",
      filename: "secret.txt",
      contentType: "text/plain",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
