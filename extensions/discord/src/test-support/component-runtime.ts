import { readChannelIngressStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/channel-ingress-runtime";
// Discord plugin module implements component runtime behavior.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  parsePluginBindingApprovalCustomId,
  resolvePinnedMainDmOwnerFromAllowlist,
} from "openclaw/plugin-sdk/conversation-runtime";
import { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
import { vi, type Mock } from "vitest";
import { setDiscordRuntime } from "../runtime.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyMock = Mock<DispatchReplyWithBufferedBlockDispatcherFn>;
type ReadAllowFromStore = NonNullable<
  Parameters<typeof readChannelIngressStoreAllowFromForDmPolicy>[0]["readStore"]
>;
type ReadAllowFromStoreMock = Mock<ReadAllowFromStore>;
type ComponentContext = Parameters<
  (typeof import("../monitor/agent-components.js").createDiscordComponentControls)[number]
>[0];

type DiscordComponentRuntimeMocks = {
  buildPluginBindingResolvedTextMock: UnknownMock;
  dispatchPluginInteractiveHandlerMock: AsyncUnknownMock;
  dispatchReplyMock: DispatchReplyMock;
  enqueueSystemEventMock: UnknownMock;
  readAllowFromStoreMock: ReadAllowFromStoreMock;
  readSessionUpdatedAtMock: UnknownMock;
  recordInboundSessionMock: AsyncUnknownMock;
  resolveStorePathMock: UnknownMock;
  resolvePluginConversationBindingApprovalMock: AsyncUnknownMock;
  upsertPairingRequestMock: AsyncUnknownMock;
};

const runtimeMocks = vi.hoisted((): DiscordComponentRuntimeMocks => ({
  buildPluginBindingResolvedTextMock: vi.fn(),
  dispatchPluginInteractiveHandlerMock: vi.fn(),
  dispatchReplyMock: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(),
  enqueueSystemEventMock: vi.fn(),
  readAllowFromStoreMock: vi.fn<ReadAllowFromStore>(),
  readSessionUpdatedAtMock: vi.fn(),
  recordInboundSessionMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
  resolvePluginConversationBindingApprovalMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
}));

export const readAllowFromStoreMock: ReadAllowFromStoreMock = runtimeMocks.readAllowFromStoreMock;
export const dispatchPluginInteractiveHandlerMock: AsyncUnknownMock =
  runtimeMocks.dispatchPluginInteractiveHandlerMock;
export const dispatchReplyMock: DispatchReplyMock = runtimeMocks.dispatchReplyMock;
export const enqueueSystemEventMock: UnknownMock = runtimeMocks.enqueueSystemEventMock;
export const upsertPairingRequestMock: AsyncUnknownMock = runtimeMocks.upsertPairingRequestMock;
export const recordInboundSessionMock: AsyncUnknownMock = runtimeMocks.recordInboundSessionMock;
export const readSessionUpdatedAtMock: UnknownMock = runtimeMocks.readSessionUpdatedAtMock;
export const resolveStorePathMock: UnknownMock = runtimeMocks.resolveStorePathMock;
const resolvePluginConversationBindingApprovalMock: AsyncUnknownMock =
  runtimeMocks.resolvePluginConversationBindingApprovalMock;
const buildPluginBindingResolvedTextMock: UnknownMock =
  runtimeMocks.buildPluginBindingResolvedTextMock;

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  type RunParams = Parameters<typeof actual.runChannelInboundEvent>[0];
  return {
    ...actual,
    runChannelInboundEvent: (params: RunParams) => {
      const runtime = createPluginRuntimeMock({
        channel: {
          session: {
            resolveStorePath: (...args) => resolveStorePathMock(...args) as string,
            recordInboundSession: async (...args) => {
              await recordInboundSessionMock(...args);
            },
          },
          reply: {
            dispatchReplyWithBufferedBlockDispatcher: (...args) => dispatchReplyMock(...args),
          },
        },
      });
      return runtime.channel.inbound.run(params);
    },
  };
});
vi.mock("../monitor/agent-components-helpers.runtime.js", () => {
  return {
    readChannelIngressStoreAllowFromForDmPolicy: (
      params: Parameters<typeof readChannelIngressStoreAllowFromForDmPolicy>[0],
    ) =>
      readChannelIngressStoreAllowFromForDmPolicy({ ...params, readStore: readAllowFromStoreMock }),
    resolvePinnedMainDmOwnerFromAllowlist,
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
  };
});

vi.mock("../monitor/agent-components.runtime.js", () => {
  return {
    buildPluginBindingResolvedText: (...args: unknown[]) =>
      buildPluginBindingResolvedTextMock(...args),
    createReplyReferencePlanner,
    dispatchPluginInteractiveHandler: (...args: unknown[]) =>
      dispatchPluginInteractiveHandlerMock(...args),
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyMock,
    finalizeInboundContext: vi.fn((ctx) => ctx),
    parsePluginBindingApprovalCustomId,
    recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
    resolveChunkMode: vi.fn(() => "sentences"),
    resolvePluginConversationBindingApproval: (...args: unknown[]) =>
      resolvePluginConversationBindingApprovalMock(...args),
    resolveTextChunkLimit: vi.fn(() => 2000),
  };
});

vi.mock("../monitor/agent-components.deps.runtime.js", () => {
  return {
    enqueueRoutedSystemEvent: (
      text: unknown,
      route: { sessionKey: unknown },
      options: Record<string, unknown>,
    ) => enqueueSystemEventMock(text, { ...options, sessionKey: route.sessionKey }),
    readSessionUpdatedAt: (...args: unknown[]) => readSessionUpdatedAtMock(...args),
    resolveStorePath: (...args: unknown[]) => resolveStorePathMock(...args),
  };
});

vi.mock("../interactive-dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../interactive-dispatch.js")>(
    "../interactive-dispatch.js",
  );
  return {
    ...actual,
    dispatchDiscordPluginInteractiveHandler: (...args: unknown[]) =>
      dispatchPluginInteractiveHandlerMock(...args),
  };
});

export const createDiscordComponentTestConfig = (): OpenClawConfig => ({
  channels: { discord: { replyToMode: "first" } },
});

export const createDiscordComponentTestAccountConfig = (
  overrides?: Partial<DiscordAccountConfig>,
): DiscordAccountConfig => ({ replyToMode: "first", ...overrides });

export const createDiscordComponentTestContext = (
  overrides?: Partial<ComponentContext>,
): ComponentContext => ({
  cfg: createDiscordComponentTestConfig(),
  accountId: "default",
  dmPolicy: "allowlist",
  allowFrom: ["123456789"],
  discordConfig: createDiscordComponentTestAccountConfig(),
  token: "token",
  ...overrides,
});

export function installDiscordMonitorReplyDispatcher(params: {
  onContext: (ctx: Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0]["ctx"]) => void;
  texts?: readonly string[];
}): void {
  dispatchReplyMock.mockImplementation(async (input) => {
    params.onContext(input.ctx);
    const texts = params.texts ?? ["ok"];
    for (const text of texts) {
      await input.dispatcherOptions.deliver({ text }, { kind: "final" });
    }
    return { queuedFinal: false, counts: { block: 0, final: texts.length, tool: 0 } };
  });
}

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
      requestedAt: Date.now(),
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
