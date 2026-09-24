// Feishu plugin module implements lifecycle support behavior.
import { vi, type Mock } from "vitest";
import { feishuDedupeState } from "./dedup-state.js";

type RuntimeConversationBindingRoute =
  typeof import("openclaw/plugin-sdk/conversation-runtime").resolveRuntimeConversationBindingRoute;
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type DispatchReplyCounts = {
  final: number;
  block?: number;
  tool?: number;
};
type DispatchReplyContext = Record<string, unknown> & {
  SessionKey?: string;
};
type DispatchReplyDispatcher = {
  sendFinalReply: (payload: { text: string }) => unknown;
  waitForIdle?: () => Promise<void>;
  markComplete?: () => void;
  getFailedCounts?: UnknownMock;
};
type FeishuReplyDispatcherMockValue = {
  dispatcherOptions: Record<string, never>;
  delivery: { deliver: AsyncUnknownMock };
  replyOptions: Record<string, never>;
  ensureNoVisibleReplyFallback?: AsyncUnknownMock;
};
type CreateFeishuReplyDispatcherMock = Mock<(params?: unknown) => FeishuReplyDispatcherMockValue>;
type DispatchReplyFromConfigMock = Mock<
  (params: {
    ctx: DispatchReplyContext;
    dispatcher: DispatchReplyDispatcher;
    replyOptions?: {
      turnAdoptionLifecycle?: {
        onAdopted: () => void | Promise<void>;
      };
    };
  }) => Promise<{ queuedFinal: boolean; counts: DispatchReplyCounts }>
>;
type FeishuLifecycleTestMocks = {
  createEventDispatcherMock: UnknownMock;
  monitorWebSocketMock: AsyncUnknownMock;
  monitorWebhookMock: AsyncUnknownMock;
  createFeishuThreadBindingManagerMock: UnknownMock;
  createFeishuReplyDispatcherMock: CreateFeishuReplyDispatcherMock;
  resolveRuntimeConversationBindingRouteMock: Mock<RuntimeConversationBindingRoute>;
  resolveAgentRouteMock: UnknownMock;
  resolveConfiguredBindingRouteMock: UnknownMock;
  ensureConfiguredBindingRouteReadyMock: UnknownMock;
  dispatchReplyFromConfigMock: DispatchReplyFromConfigMock;
  getMessageFeishuMock: AsyncUnknownMock;
  listFeishuThreadMessagesMock: AsyncUnknownMock;
  sendMessageFeishuMock: AsyncUnknownMock;
  sendCardFeishuMock: AsyncUnknownMock;
};

const feishuLifecycleTestMocks = vi.hoisted((): FeishuLifecycleTestMocks => ({
  createEventDispatcherMock: vi.fn(),
  monitorWebSocketMock: vi.fn(async () => {}),
  monitorWebhookMock: vi.fn(async () => {}),
  createFeishuThreadBindingManagerMock: vi.fn(() => ({ stop: vi.fn() })),
  createFeishuReplyDispatcherMock: vi.fn(),
  resolveRuntimeConversationBindingRouteMock: vi.fn<RuntimeConversationBindingRoute>(),
  resolveAgentRouteMock: vi.fn(),
  resolveConfiguredBindingRouteMock: vi.fn(),
  ensureConfiguredBindingRouteReadyMock: vi.fn(),
  dispatchReplyFromConfigMock: vi.fn(),
  getMessageFeishuMock: vi.fn(async () => null),
  listFeishuThreadMessagesMock: vi.fn(async () => []),
  sendMessageFeishuMock: vi.fn(async () => ({ messageId: "om_sent", chatId: "chat_default" })),
  sendCardFeishuMock: vi.fn(async () => ({ messageId: "om_card", chatId: "chat_default" })),
}));

export function getFeishuLifecycleTestMocks(): FeishuLifecycleTestMocks {
  return feishuLifecycleTestMocks;
}

export function resetFeishuLifecycleTestMocks(): void {
  feishuDedupeState.reset();
  for (const mock of Object.values(feishuLifecycleTestMocks)) {
    mock.mockReset();
  }
  feishuLifecycleTestMocks.monitorWebSocketMock.mockResolvedValue(undefined);
  feishuLifecycleTestMocks.monitorWebhookMock.mockResolvedValue(undefined);
  feishuLifecycleTestMocks.createFeishuThreadBindingManagerMock.mockReturnValue({ stop: vi.fn() });
  feishuLifecycleTestMocks.resolveRuntimeConversationBindingRouteMock.mockImplementation(
    ({ route }) => ({ bindingRecord: null, route }),
  );
  feishuLifecycleTestMocks.getMessageFeishuMock.mockResolvedValue(null);
  feishuLifecycleTestMocks.listFeishuThreadMessagesMock.mockResolvedValue([]);
  feishuLifecycleTestMocks.sendMessageFeishuMock.mockResolvedValue({
    messageId: "om_sent",
    chatId: "chat_default",
  });
  feishuLifecycleTestMocks.sendCardFeishuMock.mockResolvedValue({
    messageId: "om_card",
    chatId: "chat_default",
  });
}

const {
  createEventDispatcherMock,
  monitorWebSocketMock,
  monitorWebhookMock,
  createFeishuThreadBindingManagerMock,
  createFeishuReplyDispatcherMock,
  resolveRuntimeConversationBindingRouteMock,
  resolveConfiguredBindingRouteMock,
  ensureConfiguredBindingRouteReadyMock,
  getMessageFeishuMock,
  listFeishuThreadMessagesMock,
  sendMessageFeishuMock,
  sendCardFeishuMock,
} = feishuLifecycleTestMocks;

vi.mock("./client.js", () => {
  return {
    FEISHU_HTTP_TIMEOUT_ENV_VAR: "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS",
    FEISHU_HTTP_TIMEOUT_MAX_MS: 300_000,
    FEISHU_HTTP_TIMEOUT_MS: 30_000,
    FEISHU_USER_AGENT: "openclaw-feishu-test",
    clearClientCache: vi.fn(),
    createFeishuClient: vi.fn(() => {
      throw new Error("unexpected Feishu client call in lifecycle test");
    }),
    createFeishuWSClient: vi.fn(async () => ({
      close: vi.fn(),
      start: vi.fn(),
    })),
    createEventDispatcher: createEventDispatcherMock,
    getFeishuUserAgent: vi.fn(() => "openclaw-feishu-test"),
    pluginVersion: "test",
    setFeishuClientRuntimeForTest: vi.fn(),
  };
});

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: createFeishuReplyDispatcherMock,
}));

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  getMessageFeishu: getMessageFeishuMock,
  listFeishuThreadMessages: listFeishuThreadMessagesMock,
  sendMessageFeishu: sendMessageFeishuMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    resolveConfiguredBindingRoute: (
      params: Parameters<typeof actual.resolveConfiguredBindingRoute>[0],
    ) =>
      resolveConfiguredBindingRouteMock.getMockImplementation()
        ? resolveConfiguredBindingRouteMock(params)
        : actual.resolveConfiguredBindingRoute(params),
    resolveRuntimeConversationBindingRoute: resolveRuntimeConversationBindingRouteMock,
    ensureConfiguredBindingRouteReady: (
      params: Parameters<typeof actual.ensureConfiguredBindingRouteReady>[0],
    ) =>
      ensureConfiguredBindingRouteReadyMock.getMockImplementation()
        ? ensureConfiguredBindingRouteReadyMock(params)
        : actual.ensureConfiguredBindingRouteReady(params),
  };
});
