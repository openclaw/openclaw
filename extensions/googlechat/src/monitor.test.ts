import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, WebhookTarget } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

type ProcessEventFn = (event: GoogleChatEvent, target: WebhookTarget) => Promise<void>;
type DispatchParams = {
  dispatcherOptions: {
    deliver: (payload: { text?: string }) => Promise<void>;
  };
};

const mocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
  createChannelReplyPipeline: vi.fn(),
  deleteGoogleChatMessage: vi.fn(),
  deliverGoogleChatReply: vi.fn(),
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
  downloadGoogleChatMedia: vi.fn(),
  finalizeInboundContext: vi.fn(),
  recordSessionMetaFromInbound: vi.fn(),
  resolveInboundRouteEnvelopeBuilderWithRuntime: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  setGoogleChatWebhookEventProcessor: vi.fn(),
}));

vi.mock("../runtime-api.js", () => ({
  createChannelReplyPipeline: mocks.createChannelReplyPipeline,
  resolveInboundRouteEnvelopeBuilderWithRuntime:
    mocks.resolveInboundRouteEnvelopeBuilderWithRuntime,
  resolveWebhookPath: vi.fn(() => "/googlechat"),
}));

vi.mock("./api.js", () => ({
  deleteGoogleChatMessage: mocks.deleteGoogleChatMessage,
  downloadGoogleChatMedia: mocks.downloadGoogleChatMedia,
  sendGoogleChatMessage: mocks.sendGoogleChatMessage,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: mocks.applyGoogleChatInboundAccessPolicy,
  isSenderAllowed: vi.fn(),
}));

vi.mock("./monitor-reply-delivery.js", () => ({
  deliverGoogleChatReply: mocks.deliverGoogleChatReply,
}));

vi.mock("./monitor-routing.js", () => ({
  handleGoogleChatWebhookRequest: vi.fn(),
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: mocks.setGoogleChatWebhookEventProcessor,
}));

vi.mock("./monitor-webhook.js", () => ({
  warnAppPrincipalMisconfiguration: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime: vi.fn(),
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: { typingIndicator: "reaction" },
} as ResolvedGoogleChatAccount;

const config = {
  agents: {
    list: [{ id: "agent-1", name: "Claw" }],
  },
} as OpenClawConfig;

function createCore(): GoogleChatCoreRuntime {
  return {
    logging: {
      shouldLogVerbose: vi.fn(() => false),
    },
    channel: {
      reply: {
        finalizeInboundContext: mocks.finalizeInboundContext,
        dispatchReplyWithBufferedBlockDispatcher: mocks.dispatchReplyWithBufferedBlockDispatcher,
      },
      session: {
        recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
      },
    },
  } as unknown as GoogleChatCoreRuntime;
}

function createTarget(): WebhookTarget {
  return {
    account,
    config,
    runtime: {
      error: vi.fn(),
      log: vi.fn(),
    },
    core: createCore(),
    path: "/googlechat",
    mediaMaxMb: 20,
  };
}

const messageEvent = {
  type: "MESSAGE",
  eventTime: "2026-04-28T00:00:00.000Z",
  space: {
    name: "spaces/AAA",
    displayName: "General",
    type: "ROOM",
  },
  message: {
    name: "spaces/AAA/messages/source",
    text: "👍",
    sender: {
      name: "users/alice",
      displayName: "Alice",
      email: "alice@example.com",
      type: "HUMAN",
    },
    thread: {
      name: "spaces/AAA/threads/root",
    },
  },
} satisfies GoogleChatEvent;

let processEvent: ProcessEventFn;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();

  mocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
    ok: true,
    commandAuthorized: false,
    effectiveWasMentioned: true,
    groupSystemPrompt: undefined,
  });
  mocks.createChannelReplyPipeline.mockReturnValue({
    onModelSelected: vi.fn(),
  });
  mocks.deleteGoogleChatMessage.mockResolvedValue(undefined);
  mocks.deliverGoogleChatReply.mockResolvedValue(undefined);
  mocks.dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(undefined);
  mocks.finalizeInboundContext.mockImplementation((ctx) => ctx);
  mocks.recordSessionMetaFromInbound.mockResolvedValue(undefined);
  mocks.resolveInboundRouteEnvelopeBuilderWithRuntime.mockReturnValue({
    route: {
      accountId: "default",
      agentId: "agent-1",
      sessionKey: "googlechat:spaces/AAA",
    },
    buildEnvelope: vi.fn(() => ({
      storePath: "sessions/googlechat-spaces-AAA.json",
      body: "👍",
    })),
  });
  mocks.sendGoogleChatMessage.mockResolvedValue({
    messageName: "spaces/AAA/messages/typing",
  });
  mocks.setGoogleChatWebhookEventProcessor.mockImplementation((handler: ProcessEventFn) => {
    processEvent = handler;
  });

  await import("./monitor.js");
});

describe("Google Chat monitor", () => {
  it("deletes a typing message when an emoji reaction turn resolves to exact NO_REPLY without delivery", async () => {
    const target = createTarget();

    await processEvent(messageEvent, target);

    expect(mocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherOptions: expect.objectContaining({
          deliver: expect.any(Function),
        }),
      }),
    );
    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(target.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('typingIndicator="reaction" requires user OAuth'),
    );
  });

  it("does not delete the typing message again after normal reply delivery owns it", async () => {
    const target = createTarget();
    mocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchParams) => {
        await dispatcherOptions.deliver({ text: "visible reply" });
      },
    );

    await processEvent(messageEvent, target);

    expect(mocks.deliverGoogleChatReply).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        typingMessageName: "spaces/AAA/messages/typing",
      }),
    );
    expect(mocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
  });
});
