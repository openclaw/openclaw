import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

// P3: mock respawn so we don't actually spawn an ACP child over the gateway
// in these preflight tests. We verify the respawn call and its inputs.
const respawnMock = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
vi.mock("./thread-bindings.respawn.js", async () => {
  const actual = await vi.importActual<typeof import("./thread-bindings.respawn.js")>(
    "./thread-bindings.respawn.js",
  );
  return {
    ...actual,
    respawnBoundAcpThread: respawnMock,
  };
});

// P3: stub the ACP session manager so preflight's liveness check returns
// the kind we want (ready / stale / none).
const resolveSessionMock = vi.hoisted(() => vi.fn<() => unknown>());
vi.mock("openclaw/plugin-sdk/acp-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
    "openclaw/plugin-sdk/acp-runtime",
  );
  return {
    ...actual,
    getAcpSessionManager: () => ({
      resolveSession: resolveSessionMock,
    }),
  };
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { __testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  type DiscordClient,
  type DiscordConfig,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";
import {
  __testing as threadBindingsTesting,
  createThreadBindingManager,
} from "./thread-bindings.js";

const GUILD_ID = "guild-1";
const PARENT_CHANNEL_ID = "parent-1";
const THREAD_ID = "thread-1";
const BOT_ID = "bot-1";
const ACCOUNT_ID = "default";
const BOUND_SESSION_KEY = "agent:codex:acp:11111111-1111-1111-1111-111111111111";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  acp: { enabled: true, dispatch: { enabled: true }, backend: "acpx" },
  channels: {
    discord: { threadBindings: { enabled: true } },
  },
} satisfies OpenClawConfig;

function createGuildThreadClient(): DiscordClient {
  return {
    fetchChannel: async (id: string) => {
      if (id === THREAD_ID) {
        return {
          id: THREAD_ID,
          type: ChannelType.PublicThread,
          name: "codex-thread",
          parentId: PARENT_CHANNEL_ID,
          ownerId: BOT_ID,
          isThread: () => true,
        };
      }
      if (id === PARENT_CHANNEL_ID) {
        return {
          id: PARENT_CHANNEL_ID,
          type: ChannelType.GuildText,
          name: "general",
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

function createGuildThreadMessage(params: {
  id: string;
  content: string;
  mentionedUsers?: Array<{ id: string }>;
}) {
  return createDiscordMessage({
    id: params.id,
    channelId: THREAD_ID,
    content: params.content,
    mentionedUsers: params.mentionedUsers,
    author: { id: "user-1", bot: false, username: "alice" },
  });
}

function createGuildThreadEvent(
  message: ReturnType<typeof createGuildThreadMessage>,
): DiscordMessageEvent {
  return {
    channel_id: THREAD_ID,
    guild_id: GUILD_ID,
    guild: { id: GUILD_ID, name: "Guild One" },
    author: message.author,
    message,
  } as unknown as DiscordMessageEvent;
}

async function seedThreadBinding(opts?: {
  targetSessionKey?: string;
  metadata?: Record<string, unknown>;
  webhookId?: string;
  webhookToken?: string;
}) {
  const manager = createThreadBindingManager({
    accountId: ACCOUNT_ID,
    persist: false,
    enableSweeper: false,
  });
  const bound = await manager.bindTarget({
    threadId: THREAD_ID,
    channelId: PARENT_CHANNEL_ID,
    targetKind: "acp",
    targetSessionKey: opts?.targetSessionKey ?? BOUND_SESSION_KEY,
    agentId: "codex",
    label: "codex-thread",
    boundBy: "user-1",
    webhookId: opts?.webhookId ?? "wh-stable-1",
    webhookToken: opts?.webhookToken ?? "whk-stable-1",
    metadata: {
      agentId: "codex",
      label: "codex-thread",
      ...opts?.metadata,
    },
  });
  expect(bound).not.toBeNull();
  return { manager, bound: bound! };
}

function runPreflight(args: {
  message: ReturnType<typeof createGuildThreadMessage>;
  threadBindings: ReturnType<typeof createThreadBindingManager>;
  allowedGuild?: boolean;
}) {
  const guildEntries = args.allowedGuild
    ? {
        [GUILD_ID]: {
          id: GUILD_ID,
          channels: {
            [PARENT_CHANNEL_ID]: { enabled: true, requireMention: false },
          },
        },
      }
    : undefined;
  return preflightDiscordMessage({
    ...createDiscordPreflightArgs({
      cfg: baseCfg,
      discordConfig: {} as DiscordConfig,
      data: createGuildThreadEvent(args.message),
      client: createGuildThreadClient(),
      botUserId: BOT_ID,
    }),
    guildEntries,
    groupPolicy: "open",
    threadBindings: args.threadBindings,
  });
}

describe("preflightDiscordMessage — Phase 11 inbound routing", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    threadBindingsTesting.resetThreadBindingsForTests();
    loadConfigMock.mockReset().mockReturnValue(baseCfg);
    respawnMock.mockReset();
    respawnMock.mockImplementation(async () => ({
      ok: false,
      errorCode: "respawn_failed",
      error: "test-mock: respawn disabled by default",
    }));
    resolveSessionMock.mockReset();
    resolveSessionMock.mockReturnValue({ kind: "ready", sessionKey: "stub", meta: {} });
  });

  describe("R22 — inbound routes to bound ACP child", () => {
    it("routes thread inbound to the bound ACP session key", async () => {
      const { manager } = await seedThreadBinding();
      const msg = createGuildThreadMessage({
        id: "m-thread-1",
        content: "hello in thread",
      });
      const result = await runPreflight({
        message: msg,
        threadBindings: manager,
        allowedGuild: true,
      });
      expect(result).not.toBeNull();
      expect(result?.route.sessionKey).toBe(BOUND_SESSION_KEY);
      expect(result?.boundSessionKey).toBe(BOUND_SESSION_KEY);
      expect(result?.boundAgentId).toBe("codex");
    });

    it("local-fallback fires when the session-binding adapter is unregistered", async () => {
      const { manager } = await seedThreadBinding();
      // Simulate cold start: strip the session-binding adapter but keep the
      // local thread-binding manager populated. preflight must fall back.
      sessionBindingTesting.resetSessionBindingAdaptersForTests();

      const msg = createGuildThreadMessage({
        id: "m-thread-cold",
        content: "cold-start message",
      });
      const result = await runPreflight({
        message: msg,
        threadBindings: manager,
        allowedGuild: true,
      });
      expect(result).not.toBeNull();
      expect(result?.route.sessionKey).toBe(BOUND_SESSION_KEY);
      expect(result?.boundSessionKey).toBe(BOUND_SESSION_KEY);
    });
  });

  describe("R23 — main-mention escape hatch", () => {
    it("overrides binding when main is explicitly @-mentioned", async () => {
      const { manager } = await seedThreadBinding();
      const msg = createGuildThreadMessage({
        id: "m-main-mention",
        content: `<@${BOT_ID}> hey main`,
        mentionedUsers: [{ id: BOT_ID }],
      });
      const result = await runPreflight({
        message: msg,
        threadBindings: manager,
        allowedGuild: true,
      });
      expect(result).not.toBeNull();
      // Not routed to the bound ACP session.
      expect(result?.boundSessionKey).toBeUndefined();
      expect(result?.route.sessionKey).not.toBe(BOUND_SESSION_KEY);
      expect(result?.skipConversationBindingLookup).toBe(true);
      // Respawn must not have been triggered for a main-mention bypass.
      expect(respawnMock).not.toHaveBeenCalled();
    });
  });

  describe("R24 — expired session respawn", () => {
    it("respawns in place when the bound session is stale", async () => {
      const { manager, bound } = await seedThreadBinding();
      // Pretend the ACP session is stale.
      resolveSessionMock.mockReturnValue({
        kind: "stale",
        sessionKey: BOUND_SESSION_KEY,
        error: { code: "ACP_SESSION_MISSING", message: "gone" } as never,
      });
      respawnMock.mockImplementation(async (input: unknown) => {
        // Verify call shape: same binding, same thread-binding manager.
        const typed = input as {
          binding: { conversation: { conversationId: string } };
          threadBindingsManager: { getByThreadId?: (id: string) => unknown };
        };
        expect(typed.binding.conversation.conversationId).toBe(THREAD_ID);
        expect(typeof typed.threadBindingsManager.getByThreadId).toBe("function");
        return {
          ok: true,
          newBinding: {
            bindingId: `discord:${ACCOUNT_ID}:${THREAD_ID}`,
            targetSessionKey: "agent:codex:acp:fresh-uuid",
            targetKind: "session" as const,
            conversation: {
              channel: "discord",
              accountId: ACCOUNT_ID,
              conversationId: THREAD_ID,
              parentConversationId: PARENT_CHANNEL_ID,
            },
            status: "active" as const,
            boundAt: Date.now(),
            metadata: { agentId: "codex", label: "codex-thread" },
          },
          newSessionKey: "agent:codex:acp:fresh-uuid",
          agentId: "codex",
        };
      });

      const msg = createGuildThreadMessage({
        id: "m-stale",
        content: "post-restart message",
      });
      const result = await runPreflight({
        message: msg,
        threadBindings: manager,
        allowedGuild: true,
      });
      expect(respawnMock).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result?.route.sessionKey).toBe("agent:codex:acp:fresh-uuid");
      expect(result?.boundSessionKey).toBe("agent:codex:acp:fresh-uuid");
      // Original bound record remains unchanged in the in-memory manager
      // (the mock respawn doesn't touch it). This confirms preflight is
      // using the new session binding returned by the helper.
      expect(bound.targetSessionKey).toBe(BOUND_SESSION_KEY);
    });

    it("treats status=ended bindings as respawn candidates", async () => {
      const { manager } = await seedThreadBinding();
      // Mark the binding as ended (Phase 11 P4).
      manager.endBinding({ threadId: THREAD_ID, reason: "session-closed" });
      // Ready resolve shouldn't matter because endedAt forces respawn.
      resolveSessionMock.mockReturnValue({
        kind: "ready",
        sessionKey: BOUND_SESSION_KEY,
        meta: {} as never,
      });
      respawnMock.mockImplementation(async () => ({
        ok: true,
        newBinding: {
          bindingId: `discord:${ACCOUNT_ID}:${THREAD_ID}`,
          targetSessionKey: "agent:codex:acp:fresh-uuid-2",
          targetKind: "session" as const,
          conversation: {
            channel: "discord",
            accountId: ACCOUNT_ID,
            conversationId: THREAD_ID,
            parentConversationId: PARENT_CHANNEL_ID,
          },
          status: "active" as const,
          boundAt: Date.now(),
          metadata: { agentId: "codex", label: "codex-thread" },
        },
        newSessionKey: "agent:codex:acp:fresh-uuid-2",
        agentId: "codex",
      }));

      const msg = createGuildThreadMessage({
        id: "m-ended",
        content: "resume the ended session",
      });
      const result = await runPreflight({
        message: msg,
        threadBindings: manager,
        allowedGuild: true,
      });
      expect(respawnMock).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result?.route.sessionKey).toBe("agent:codex:acp:fresh-uuid-2");
    });
  });
});

describe("ThreadBindingManager.endBinding — Phase 11 P4", () => {
  beforeEach(() => {
    threadBindingsTesting.resetThreadBindingsForTests();
  });

  it("marks the record as ended without destroying webhook credentials", async () => {
    const manager = createThreadBindingManager({
      accountId: ACCOUNT_ID,
      persist: false,
      enableSweeper: false,
    });
    const bound = await manager.bindTarget({
      threadId: THREAD_ID,
      channelId: PARENT_CHANNEL_ID,
      targetKind: "acp",
      targetSessionKey: BOUND_SESSION_KEY,
      agentId: "codex",
      label: "codex-thread",
      webhookId: "wh-keep",
      webhookToken: "whk-keep",
      metadata: { agentId: "codex", label: "codex-thread" },
    });
    expect(bound).not.toBeNull();

    const ended = manager.endBinding({
      threadId: THREAD_ID,
      reason: "session-closed",
    });
    expect(ended).not.toBeNull();
    expect(ended?.endedAt).toBeDefined();
    expect(ended?.endedReason).toBe("session-closed");
    expect(ended?.webhookId).toBe("wh-keep");
    expect(ended?.webhookToken).toBe("whk-keep");
    expect(ended?.metadata?.agentId).toBe("codex");

    // Still present in the manager after endBinding (unlike unbindThread).
    const after = manager.getByThreadId(THREAD_ID);
    expect(after).not.toBeUndefined();
    expect(after?.endedAt).toBeDefined();
    expect(after?.webhookId).toBe("wh-keep");
  });

  it("returns null for unknown thread ids", () => {
    const manager = createThreadBindingManager({
      accountId: ACCOUNT_ID,
      persist: false,
      enableSweeper: false,
    });
    expect(manager.endBinding({ threadId: "nope" })).toBeNull();
  });
});
