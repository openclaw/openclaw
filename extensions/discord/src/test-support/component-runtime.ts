import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { vi } from "vitest";
import { setDiscordRuntime } from "../runtime.js";

type UnknownFn = (...args: unknown[]) => unknown;
type AsyncUnknownFn = (...args: unknown[]) => Promise<unknown>;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
const runtimeMocks = vi.hoisted(() => ({
  dispatchPluginInteractiveHandlerMock: vi.fn<AsyncUnknownFn>(),
  dispatchReplyMock: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(),
  enqueueSystemEventMock: vi.fn<UnknownFn>(),
  readAllowFromStoreMock: vi.fn<(...args: string[]) => Promise<string[]>>(),
  readSessionUpdatedAtMock: vi.fn<UnknownFn>(),
  recordInboundSessionMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  resolveStorePathMock: vi.fn<(...args: unknown[]) => string>(),
  resolvePluginConversationBindingApprovalMock:
    vi.fn<
      typeof import("openclaw/plugin-sdk/conversation-runtime").resolvePluginConversationBindingApproval
    >(),
  upsertPairingRequestMock: vi.fn<AsyncUnknownFn>(),
}));

export const {
  readAllowFromStoreMock,
  dispatchPluginInteractiveHandlerMock,
  dispatchReplyMock,
  enqueueSystemEventMock,
  upsertPairingRequestMock,
  recordInboundSessionMock,
  readSessionUpdatedAtMock,
  resolveStorePathMock,
} = runtimeMocks;
const { resolvePluginConversationBindingApprovalMock } = runtimeMocks;

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type RunParams = Parameters<typeof actual.runChannelInboundEvent>[0];
  return {
    ...actual,
    runChannelInboundEvent: (params: RunParams) =>
      createPluginRuntimeMock({
        channel: {
          session: {
            resolveStorePath: resolveStorePathMock,
            recordInboundSession: recordInboundSessionMock,
          },
          reply: { dispatchReplyWithBufferedBlockDispatcher: dispatchReplyMock },
        },
      }).channel.inbound.run(params),
  };
});
vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-ingress-runtime")>();
  return {
    ...actual,
    readChannelIngressStoreAllowFromForDmPolicy: (
      params: Parameters<typeof actual.readChannelIngressStoreAllowFromForDmPolicy>[0],
    ) =>
      actual.readChannelIngressStoreAllowFromForDmPolicy({
        ...params,
        readStore: readAllowFromStoreMock,
      }),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  upsertChannelPairingRequest: runtimeMocks.upsertPairingRequestMock,
  resolvePluginConversationBindingApproval:
    runtimeMocks.resolvePluginConversationBindingApprovalMock,
}));

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => enqueueSystemEventMock(text, { ...options, sessionKey: route.sessionKey }),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  readSessionUpdatedAtAsync: async (...args: unknown[]) => readSessionUpdatedAtMock(...args),
  resolveStorePath: runtimeMocks.resolveStorePathMock,
}));

vi.mock("../interactive-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../interactive-dispatch.js")>()),
  dispatchDiscordPluginInteractiveHandler: runtimeMocks.dispatchPluginInteractiveHandlerMock,
}));

export function resetDiscordComponentRuntimeMocks() {
  const plugin = {
    pluginId: "openclaw-codex-app-server",
    pluginName: "OpenClaw App Server",
    pluginRoot: "/plugins/codex",
  };
  const conversation = {
    channel: "discord",
    accountId: "default",
    conversationId: "user:123456789",
  };
  setDiscordRuntime(createPluginRuntimeMock());
  dispatchPluginInteractiveHandlerMock.mockReset().mockResolvedValue({
    matched: false,
    handled: false,
    duplicate: false,
  });
  dispatchReplyMock.mockClear();
  enqueueSystemEventMock.mockClear();
  readAllowFromStoreMock.mockClear().mockResolvedValue([]);
  readSessionUpdatedAtMock.mockClear().mockReturnValue(undefined);
  upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
  recordInboundSessionMock.mockClear().mockResolvedValue(undefined);
  resolveStorePathMock.mockClear().mockReturnValue("/tmp/openclaw-sessions-test.json");
  resolvePluginConversationBindingApprovalMock.mockReset().mockResolvedValue({
    status: "approved",
    binding: {
      bindingId: "binding-1",
      ...plugin,
      ...conversation,
      boundAt: Date.now(),
    },
    request: {
      id: "approval-1",
      ...plugin,
      conversation,
    },
    decision: "allow-once",
  });
}
