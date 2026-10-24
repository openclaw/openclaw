import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "../monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

export const channelConversationId = "19:general@thread.tacv2";

export function createDebounceControl() {
  let drain: () => Promise<void> = async () => {
    throw new Error("Expected the handler to create its debouncer");
  };
  const createDebouncer: typeof createInboundDebouncer = (options) => {
    const debouncer = createInboundDebouncer(options);
    drain = debouncer.drain;
    return debouncer;
  };
  return {
    createDebouncer,
    drain: () => drain(),
    async flush(milliseconds: number) {
      await vi.advanceTimersByTimeAsync(milliseconds);
      await drain();
    },
  };
}

export function createTurnContext(
  activity: MSTeamsTurnContext["activity"],
  ids?: { sent: string; updated: string },
): MSTeamsTurnContext {
  return {
    activity,
    sendActivity: vi.fn(async () => ids && { id: ids.sent }),
    updateActivity: vi.fn(async () => ids && { id: ids.updated }),
  };
}

type MessageHandlerDepsOptions = Omit<
  NonNullable<Parameters<typeof installMSTeamsTestRuntime>[0]>,
  "enqueueSystemEvent" | "upsertPairingRequest" | "recordInboundSession" | "resolveTextChunkLimit"
> & {
  accountId?: string;
};

export function createMessageHandlerDeps(
  cfg: OpenClawConfig,
  options: MessageHandlerDepsOptions = {},
) {
  const accountId = options.accountId ?? "default";
  const effects = {
    enqueueSystemEvent: vi.fn(),
    readAllowFromStore: options.readAllowFromStore ?? vi.fn(async () => []),
    upsertPairingRequest: vi.fn(async () => null),
    recordInboundSession: vi.fn(async (_params: { sessionKey: string }) => undefined),
    resolveAgentRoute:
      options.resolveAgentRoute ??
      vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
        sessionKey: `agent:main:msteams:${peer.kind}:${peer.id}`,
        agentId: "main",
        accountId,
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session" as const,
        matchedBy: "default" as const,
      })),
  };
  installMSTeamsTestRuntime({
    ...options,
    ...effects,
    resolveTextChunkLimit: () => 4000,
    resolveStorePath: options.resolveStorePath ?? (() => "/tmp/test-store"),
  });

  const defaults = createMSTeamsMessageHandlerDeps({ cfg });
  const conversationStore = {
    ...defaults.conversationStore,
    upsert: vi.fn(async () => undefined),
  };

  const deps: MSTeamsMessageHandlerDeps = {
    ...defaults,
    accountId,
    appId: "test-app",
    tokenProvider: { getAccessToken: vi.fn(async () => "token") },
    mediaMaxBytes: 1024 * 1024,
    conversationStore,
    pollStore: {
      recordVote: vi.fn(async () => null),
    } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
  };

  return { conversationStore, deps, ...effects };
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
