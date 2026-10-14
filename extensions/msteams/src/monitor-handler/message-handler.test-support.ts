import { vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../../runtime-api.js";
import { installMSTeamsTestRuntime } from "../monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";

export const channelConversationId = "19:general@thread.tacv2";

type MessageHandlerDepsOptions = {
  accountId?: string;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
  resolveAgentRoute?: (params: {
    accountId?: string | null;
    peer: { kind: string; id: string };
  }) => unknown;
  hasControlCommand?: PluginRuntime["channel"]["text"]["hasControlCommand"];
  createInboundDebouncer?: PluginRuntime["channel"]["debounce"]["createInboundDebouncer"];
  resolveInboundDebounceMs?: PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"];
  resolveStorePath?: () => string | undefined;
  runPrepared?: NonNullable<Parameters<typeof installMSTeamsTestRuntime>[0]>["runPrepared"];
};

export function createMessageHandlerDeps(
  cfg: OpenClawConfig,
  options: MessageHandlerDepsOptions = {},
) {
  const accountId = options.accountId ?? "default";
  const enqueueSystemEvent = vi.fn();
  const readAllowFromStore = options.readAllowFromStore ?? vi.fn(async () => []);
  const upsertPairingRequest = vi.fn(async () => null);
  const recordInboundSession = vi.fn(async (_params: { sessionKey: string }) => undefined);
  const resolveAgentRoute =
    options.resolveAgentRoute ??
    vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
      sessionKey: `agent:main:msteams:${peer.kind}:${peer.id}`,
      agentId: "main",
      accountId,
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "default" as const,
    }));
  installMSTeamsTestRuntime({
    enqueueSystemEvent,
    readAllowFromStore,
    upsertPairingRequest,
    recordInboundSession,
    resolveAgentRoute,
    hasControlCommand: options.hasControlCommand,
    createInboundDebouncer: options.createInboundDebouncer,
    resolveInboundDebounceMs: options.resolveInboundDebounceMs,
    resolveTextChunkLimit: () => 4000,
    resolveStorePath: options.resolveStorePath ?? (() => "/tmp/test-store"),
    runPrepared: options.runPrepared,
  });

  const conversationStore = {
    get: vi.fn<MSTeamsMessageHandlerDeps["conversationStore"]["get"]>(async () => null),
    upsert: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => false),
    findPreferredDmByUserId: vi.fn(async () => null),
  } satisfies MSTeamsMessageHandlerDeps["conversationStore"];

  const deps: MSTeamsMessageHandlerDeps = {
    cfg,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    accountId,
    appId: "test-app",
    app: {} as MSTeamsMessageHandlerDeps["app"],
    tokenProvider: {
      getAccessToken: vi.fn(async () => "token"),
    },
    textLimit: 4000,
    mediaMaxBytes: 1024 * 1024,
    conversationStore,
    pollStore: {
      recordVote: vi.fn(async () => null),
    } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
    log: {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as MSTeamsMessageHandlerDeps["log"],
  };

  return {
    conversationStore,
    deps,
    enqueueSystemEvent,
    readAllowFromStore,
    upsertPairingRequest,
    recordInboundSession,
    resolveAgentRoute,
  };
}

export function buildChannelActivity(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    type: "message",
    text: "hello",
    from: { id: "user-id", aadObjectId: "user-aad", name: "Test User" },
    recipient: { id: "bot-id", name: "Bot" },
    conversation: { id: channelConversationId, conversationType: "channel" },
    channelData: { team: { id: "team-1" } },
    attachments: [],
    entities: [{ type: "mention", mentioned: { id: "bot-id" } }],
    ...overrides,
  };
}
