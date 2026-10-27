import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "../monitor-handler.test-helpers.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

export const channelConversationId = "19:general@thread.tacv2";

export function createDebounceControl() {
  let drain: () => Promise<void> = () => Promise.reject(new Error("Debouncer not created"));
  return {
    createDebouncer: <T>(options: Parameters<typeof createInboundDebouncer<T>>[0]) => {
      const debouncer = createInboundDebouncer(options);
      drain = debouncer.drain;
      return debouncer;
    },
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

export function createMessageHandlerDeps(
  cfg: OpenClawConfig,
  options: Omit<
    NonNullable<Parameters<typeof installMSTeamsTestRuntime>[0]>,
    "enqueueSystemEvent" | "upsertPairingRequest" | "recordInboundSession" | "resolveTextChunkLimit"
  > & { accountId?: string } = {},
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
      })),
  };
  installMSTeamsTestRuntime({
    ...options,
    ...effects,
    resolveStorePath: options.resolveStorePath ?? (() => "/tmp/test-store"),
  });

  const deps = createMSTeamsMessageHandlerDeps({ cfg });
  const conversationStore = Object.assign(deps.conversationStore, {
    upsert: vi.fn(async () => undefined),
  });
  deps.accountId = accountId;
  deps.appId = "test-app";
  deps.tokenProvider.getAccessToken = vi.fn(async () => "token");
  deps.mediaMaxBytes = 1024 * 1024;

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
    entities: [{ type: "mention", mentioned: { id: "bot-id" } }],
    ...overrides,
  };
}
