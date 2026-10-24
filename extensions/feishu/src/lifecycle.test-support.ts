import { vi, type Mock } from "vitest";
import { feishuDedupeState } from "./dedup-state.js";

type BoundConversation = Record<"bindingId" | "targetSessionKey", string>;
type UnknownCall = (...args: unknown[]) => unknown;
type AsyncUnknownCall = (...args: unknown[]) => Promise<unknown>;
type DispatchReplyDispatcher = {
  sendFinalReply: (payload: { text: string }) => unknown;
  waitForIdle?: () => Promise<void>;
  markComplete?: () => void;
  getFailedCounts?: Mock<UnknownCall>;
};
type FeishuReplyDispatcherMockValue = {
  dispatcherOptions: Record<string, never>;
  delivery: { deliver: Mock<AsyncUnknownCall> };
  replyOptions: Record<string, never>;
  ensureNoVisibleReplyFallback?: Mock<AsyncUnknownCall>;
};
type CreateFeishuReplyDispatcher = (params?: unknown) => FeishuReplyDispatcherMockValue;
type DispatchReplyFromConfig = (params: {
  ctx: Record<string, unknown> & { SessionKey?: string };
  dispatcher: DispatchReplyDispatcher;
  replyOptions?: {
    turnAdoptionLifecycle?: { onAdopted: () => void | Promise<void> };
  };
}) => Promise<{ queuedFinal: boolean; counts: { final: number; block?: number; tool?: number } }>;
type WithReplyDispatcher = (params: {
  dispatcher?: DispatchReplyDispatcher;
  onSettled?: () => unknown;
  run: () => unknown;
}) => Promise<unknown>;
const mocks = vi.hoisted(() => ({
  createEventDispatcherMock: vi.fn<UnknownCall>(),
  monitorWebSocketMock: vi.fn<AsyncUnknownCall>(async () => {}),
  monitorWebhookMock: vi.fn<AsyncUnknownCall>(async () => {}),
  createFeishuThreadBindingManagerMock: vi.fn<UnknownCall>(() => ({ stop: vi.fn() })),
  createFeishuReplyDispatcherMock: vi.fn<CreateFeishuReplyDispatcher>(),
  resolveBoundConversationMock: vi.fn<(ref?: unknown) => BoundConversation | null>(() => null),
  touchBindingMock: vi.fn<UnknownCall>(),
  resolveAgentRouteMock: vi.fn<UnknownCall>(),
  resolveConfiguredBindingRouteMock: vi.fn<UnknownCall>(),
  ensureConfiguredBindingRouteReadyMock: vi.fn<UnknownCall>(),
  dispatchReplyFromConfigMock: vi.fn<DispatchReplyFromConfig>(),
  withReplyDispatcherMock: vi.fn<WithReplyDispatcher>(),
  getMessageFeishuMock: vi.fn<AsyncUnknownCall>(async () => null),
  listFeishuThreadMessagesMock: vi.fn<AsyncUnknownCall>(async () => []),
  sendMessageFeishuMock: vi.fn<AsyncUnknownCall>(async () => sendResult("om_sent")),
  sendCardFeishuMock: vi.fn<AsyncUnknownCall>(async () => sendResult("om_card")),
}));

function sendResult(messageId: string) {
  return { messageId, chatId: "chat_default" };
}

export function getFeishuLifecycleTestMocks() {
  return mocks;
}

export function resetFeishuLifecycleTestMocks(): void {
  feishuDedupeState.reset();
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.monitorWebSocketMock.mockResolvedValue(undefined);
  mocks.monitorWebhookMock.mockResolvedValue(undefined);
  mocks.createFeishuThreadBindingManagerMock.mockReturnValue({ stop: vi.fn() });
  mocks.resolveBoundConversationMock.mockReturnValue(null);
  mocks.withReplyDispatcherMock.mockImplementation(async ({ dispatcher, onSettled, run }) => {
    try {
      return await run();
    } finally {
      dispatcher?.markComplete?.();
      try {
        await dispatcher?.waitForIdle?.();
      } finally {
        await onSettled?.();
      }
    }
  });
  mocks.getMessageFeishuMock.mockResolvedValue(null);
  mocks.listFeishuThreadMessagesMock.mockResolvedValue([]);
  mocks.sendMessageFeishuMock.mockResolvedValue(sendResult("om_sent"));
  mocks.sendCardFeishuMock.mockResolvedValue(sendResult("om_card"));
}

// mock-isolation: Lifecycle fixtures must not create real Feishu clients or SDK interceptors.
vi.mock("./client.js", () => ({
  FEISHU_HTTP_TIMEOUT_ENV_VAR: "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS",
  FEISHU_HTTP_TIMEOUT_MAX_MS: 300_000,
  FEISHU_HTTP_TIMEOUT_MS: 30_000,
  FEISHU_USER_AGENT: "openclaw-feishu-test",
  clearClientCache: vi.fn(),
  createFeishuClient: vi.fn(() => {
    throw new Error("unexpected Feishu client call in lifecycle test");
  }),
  createFeishuWSClient: vi.fn(async () => ({ close: vi.fn(), start: vi.fn() })),
  createEventDispatcher: mocks.createEventDispatcherMock,
  getFeishuUserAgent: vi.fn(() => "openclaw-feishu-test"),
  pluginVersion: "test",
  setFeishuClientRuntimeForTest: vi.fn(),
}));

// mock-isolation: Lifecycle fixtures control transport completion without opening sockets or routes.
vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: mocks.monitorWebSocketMock,
  monitorWebhook: mocks.monitorWebhookMock,
}));

// mock-isolation: Synthetic bindings must not register account managers in process-global state.
vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: mocks.createFeishuThreadBindingManagerMock,
}));

// mock-isolation: Capture reply lifecycle callbacks without starting live delivery or typing work.
vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mocks.createFeishuReplyDispatcherMock,
}));

// mock-isolation: Fixture message history and send receipts replace remote Feishu requests.
vi.mock("./send.js", () => ({
  sendCardFeishu: mocks.sendCardFeishuMock,
  getMessageFeishu: mocks.getMessageFeishuMock,
  listFeishuThreadMessages: mocks.listFeishuThreadMessagesMock,
  sendMessageFeishu: mocks.sendMessageFeishuMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/conversation-binding-runtime")
  >("openclaw/plugin-sdk/conversation-binding-runtime");
  return {
    ...actual,
    resolveConfiguredBindingRoute: (
      params: Parameters<typeof actual.resolveConfiguredBindingRoute>[0],
    ) =>
      mocks.resolveConfiguredBindingRouteMock.getMockImplementation()
        ? mocks.resolveConfiguredBindingRouteMock(params)
        : actual.resolveConfiguredBindingRoute(params),
    resolveRuntimeConversationBindingRouteAsync: async (
      params: Parameters<typeof actual.resolveRuntimeConversationBindingRouteAsync>[0],
    ) => {
      if (params.resolveRoute) {
        throw new Error("Feishu lifecycle tests require a completed route");
      }
      const conversation =
        "conversation" in params
          ? params.conversation
          : {
              channel: params.channel,
              accountId: params.accountId,
              conversationId: params.conversationId,
              parentConversationId: params.parentConversationId,
            };
      const bindingRecord = mocks.resolveBoundConversationMock(conversation);
      const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
      if (!bindingRecord || !boundSessionKey) {
        return { bindingRecord: null, route: params.route };
      }
      mocks.touchBindingMock(bindingRecord.bindingId);
      return {
        bindingRecord,
        boundSessionKey,
        boundAgentId: params.route.agentId,
        route: {
          ...params.route,
          sessionKey: boundSessionKey,
          lastRoutePolicy: boundSessionKey === params.route.mainSessionKey ? "main" : "session",
          matchedBy: "binding.channel",
        },
      };
    },
    ensureConfiguredBindingRouteReady: (
      params: Parameters<typeof actual.ensureConfiguredBindingRouteReady>[0],
    ) =>
      mocks.ensureConfiguredBindingRouteReadyMock.getMockImplementation()
        ? mocks.ensureConfiguredBindingRouteReadyMock(params)
        : actual.ensureConfiguredBindingRouteReady(params),
    getSessionBindingService: () => ({
      resolveByConversation: mocks.resolveBoundConversationMock,
      touch: mocks.touchBindingMock,
    }),
  };
});
