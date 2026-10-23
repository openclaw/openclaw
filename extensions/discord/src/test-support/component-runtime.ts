import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import type { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-runtime";
import { vi } from "vitest";
import { setDiscordRuntime } from "../runtime.js";

type UnknownFn = (...args: unknown[]) => unknown;
type AsyncUnknownFn = (...args: unknown[]) => Promise<unknown>;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
const runtimeMocks = vi.hoisted(() => ({
  buildPluginBindingResolvedTextMock: vi.fn<UnknownFn>(),
  dispatchPluginInteractiveHandlerMock: vi.fn<AsyncUnknownFn>(),
  dispatchReplyMock: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(),
  enqueueSystemEventMock: vi.fn<UnknownFn>(),
  readAllowFromStoreMock: vi.fn<AsyncUnknownFn>(),
  readSessionUpdatedAtMock: vi.fn<UnknownFn>(),
  recordInboundSessionMock: vi.fn<AsyncUnknownFn>(),
  resolveStorePathMock: vi.fn<UnknownFn>(),
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
const { resolvePluginConversationBindingApprovalMock, buildPluginBindingResolvedTextMock } =
  runtimeMocks;

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type RunParams = Parameters<typeof actual.runChannelInboundEvent>[0];
  return {
    ...actual,
    runChannelInboundEvent: (params: RunParams) =>
      createPluginRuntimeMock({
        channel: {
          session: {
            resolveStorePath: (...args) => resolveStorePathMock(...args) as string,
            recordInboundSession: async (...args) => {
              await recordInboundSessionMock(...args);
            },
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
    readChannelIngressStoreAllowFromForDmPolicy: async ({
      provider,
      accountId,
      dmPolicy,
      shouldRead,
    }: Parameters<typeof actual.readChannelIngressStoreAllowFromForDmPolicy>[0]) =>
      shouldRead === false || dmPolicy === "allowlist" || dmPolicy === "open"
        ? []
        : await readAllowFromStoreMock(provider, accountId),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  upsertChannelPairingRequest: runtimeMocks.upsertPairingRequestMock,
  buildPluginBindingResolvedText: runtimeMocks.buildPluginBindingResolvedTextMock,
  resolvePluginConversationBindingApproval:
    runtimeMocks.resolvePluginConversationBindingApprovalMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>()),
  createReplyReferencePlanner: vi.fn(
    (params: Partial<Parameters<typeof createReplyReferencePlanner>[0]>) => {
      let hasReplied = params.hasReplied ?? false;
      let nextId = params.existingId ?? params.startId;
      return {
        hasReplied: () => hasReplied,
        markSent() {
          hasReplied = true;
        },
        use() {
          if (
            params.replyToMode === "off" ||
            (isSingleUseReplyToMode(params.replyToMode ?? "off") && hasReplied)
          ) {
            return undefined;
          }
          const value = nextId;
          hasReplied = true;
          nextId = undefined;
          return value;
        },
      };
    },
  ),
  finalizeInboundContext: vi.fn((ctx) => ctx),
  resolveChunkMode: vi.fn(() => "sentences"),
  resolveTextChunkLimit: vi.fn(() => 2000),
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
      pluginId: "openclaw-codex-app-server",
      pluginName: "OpenClaw App Server",
      pluginRoot: "/plugins/codex",
      channel: "discord",
      accountId: "default",
      conversationId: "user:123456789",
      boundAt: Date.now(),
    },
    request: {
      id: "approval-1",
      pluginId: "openclaw-codex-app-server",
      pluginName: "OpenClaw App Server",
      pluginRoot: "/plugins/codex",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:123456789",
      },
    },
    decision: "allow-once",
  });
  buildPluginBindingResolvedTextMock.mockReset().mockReturnValue("Binding approved.");
}
