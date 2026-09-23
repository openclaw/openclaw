import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Telegram tests cover bot message contextm topic threadid plugin behavior.
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRecordedUpdateLastRoute,
  loadTelegramMessageContextRouteHarness,
  recordInboundSessionMock,
} from "./bot-message-context.route-test-support.js";

const bodyFixture = vi.hoisted(() => ({ text: "hello", commandAuthorized: false }));

vi.mock("./bot-message-context.body.js", () => ({
  resolveTelegramInboundBody: async () => ({
    bodyText: bodyFixture.text,
    rawBody: bodyFixture.text,
    historyKey: undefined,
    commandAuthorized: bodyFixture.commandAuthorized,
    effectiveWasMentioned: true,
    inboundEventKind: "user_request",
    mentionFacts: {
      canDetectMention: false,
      wasMentioned: true,
      effectiveWasMentioned: true,
      requireMention: false,
    },
    canDetectMention: false,
    shouldBypassMention: false,
    hasControlCommand: bodyFixture.commandAuthorized,
    stickerCacheHit: false,
    locationData: undefined,
  }),
}));

let buildTelegramMessageContextForTest: typeof import("./bot-message-context.test-harness.js").buildTelegramMessageContextForTest;
let clearRuntimeConfigSnapshot: typeof import("openclaw/plugin-sdk/runtime-config-snapshot").clearRuntimeConfigSnapshot;

describe("buildTelegramMessageContext DM topic threadId in deliveryContext (#8891)", () => {
  async function buildCtx(params: {
    message: Record<string, unknown>;
    options?: Record<string, unknown>;
    resolveGroupActivation?: () => boolean | undefined;
    sessionRuntime?: Parameters<typeof buildTelegramMessageContextForTest>[0]["sessionRuntime"];
  }) {
    return await buildTelegramMessageContextForTest({
      message: params.message,
      options: params.options,
      resolveGroupActivation: params.resolveGroupActivation,
      ...(params.sessionRuntime !== undefined ? { sessionRuntime: params.sessionRuntime } : {}),
    });
  }

  function expectRecordedRoute(params: { to: string; threadId?: string }) {
    const updateLastRoute = getRecordedUpdateLastRoute(0) as
      | { threadId?: string; to?: string }
      | undefined;
    if (!updateLastRoute) {
      throw new Error("expected recorded Telegram route");
    }
    expect(updateLastRoute.to).toBe(params.to);
    expect(updateLastRoute.threadId).toBe(params.threadId);
  }

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  beforeAll(async () => {
    ({ clearRuntimeConfigSnapshot, buildTelegramMessageContextForTest } =
      await loadTelegramMessageContextRouteHarness());
  });

  beforeEach(() => {
    recordInboundSessionMock.mockClear();
    bodyFixture.text = "hello";
    bodyFixture.commandAuthorized = false;
  });

  it("passes threadId to updateLastRoute for DM topics", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        message_thread_id: 42, // DM Topic ID
      },
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram DM topic context payload");
    }
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ to: "telegram:1234", threadId: "42" });
  });

  it.each([false, true])(
    "preserves bound route metadata through the context builder with DM topic=%s",
    async (isTopic) => {
      const targetSessionKey = "agent:main:acp:telegram-bound";
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: (conversation) =>
          conversation.conversationId === "1234"
            ? {
                bindingId: "telegram-dm-binding",
                targetSessionKey,
                targetKind: "session",
                conversation,
                status: "active",
                boundAt: 1,
              }
            : null,
      };
      registerSessionBindingAdapter(adapter);
      try {
        const ctx = await buildCtx({
          message: {
            chat: { id: 1234, type: "private" },
            ...(isTopic ? { message_thread_id: 42, is_topic_message: true } : {}),
          },
        });
        if (!ctx) {
          throw new Error("expected a bound Telegram context");
        }
        expect(ctx.ctxPayload.SessionKey).toBe(
          isTopic ? `${targetSessionKey}:thread:1234:42` : targetSessionKey,
        );
        const routeMetadataKeys = Object.getOwnPropertySymbols(ctx.route);
        expect(routeMetadataKeys).not.toHaveLength(0);
        for (const key of routeMetadataKeys) {
          expect(Reflect.get(ctx.ctxPayload, key)).toBe(Reflect.get(ctx.route, key));
        }
      } finally {
        unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });
      }
    },
  );

  it.each([false, true])(
    "keeps the Telegram-selected session through real /help initialization with DM topic=%s",
    async (isTopic) => {
      const state = await createOpenClawTestState({
        label: "telegram-derived-reply-session",
        env: { OPENCLAW_TEST_FAST: "0" },
      });
      const storePath = state.path("sessions.json");
      const targetSessionKey = "agent:main:telegram-bound";
      const selectedSessionKey = isTopic ? `${targetSessionKey}:thread:1234:42` : targetSessionKey;
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: "openai/gpt-5.4" },
          },
        },
        plugins: { enabled: false },
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
        session: { store: storePath, dmScope: "per-channel-peer" },
      };
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: (conversation) =>
          conversation.conversationId === "1234"
            ? {
                bindingId: "telegram-reply-parent-binding",
                targetSessionKey,
                targetKind: "session",
                conversation,
                status: "active",
                boundAt: 1,
              }
            : null,
      };
      registerSessionBindingAdapter(adapter);
      try {
        await state.writeConfig(cfg);
        bodyFixture.text = "/help";
        bodyFixture.commandAuthorized = true;
        const context = await buildTelegramMessageContextForTest({
          cfg,
          options: { commandSource: "text" },
          message: {
            text: "/help",
            chat: { id: 1234, type: "private" },
            ...(isTopic ? { message_thread_id: 42, is_topic_message: true } : {}),
          },
          sessionRuntime: { resolveStorePath: () => storePath },
        });
        if (!context) {
          throw new Error("expected Telegram reply context");
        }
        expect(context.ctxPayload.SessionKey).toBe(selectedSessionKey);
        expect(context.ctxPayload.CommandTargetSessionKey).toBeUndefined();
        expect(
          getSessionEntry({ agentId: "main", storePath, sessionKey: selectedSessionKey }),
        ).toBeUndefined();

        const reply = await getReplyFromConfig(context.ctxPayload, undefined, cfg);
        const replies = Array.isArray(reply) ? reply : [reply];
        expect(replies.map((payload) => payload?.text ?? "").join("\n")).toContain("ℹ️ Help");
        expect(
          getSessionEntry({ agentId: "main", storePath, sessionKey: selectedSessionKey }),
        ).toBeDefined();
        if (isTopic) {
          expect(
            getSessionEntry({ agentId: "main", storePath, sessionKey: targetSessionKey }),
          ).toBeUndefined();
        }
      } finally {
        unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });
        await state.cleanup();
      }
    },
  );

  it("builds Telegram payloads through the shared channel turn context", async () => {
    const { buildChannelInboundEventContext } = await import("openclaw/plugin-sdk/channel-inbound");
    const buildChannelInboundEventContextMock = vi.fn(buildChannelInboundEventContext);

    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        reply_to_message: {
          message_id: 9,
          date: 1_700_000_001,
          text: "parent",
          from: { id: 99, first_name: "Bob" },
        },
        from: { id: 42, first_name: "Alice", username: "alice_bot", is_bot: true },
      },
      sessionRuntime: {
        buildChannelInboundEventContext:
          buildChannelInboundEventContextMock as unknown as typeof buildChannelInboundEventContext,
      },
    });

    expect(ctx?.ctxPayload.ReplyToBody).toBe("parent");
    expect(ctx?.ctxPayload.SenderIsBot).toBe(true);
    expect(buildChannelInboundEventContextMock).toHaveBeenCalledOnce();
    const [turnOptions] = buildChannelInboundEventContextMock.mock.calls.at(0) ?? [];
    expect(turnOptions?.channel).toBe("telegram");
    expect(turnOptions?.conversation.routePeer).toEqual({ kind: "direct", id: "42" });
    expect(turnOptions?.conversation.parentId).toBeUndefined();
    expect(turnOptions?.from).toBe("telegram:1234");
    expect(turnOptions?.sender?.isBot).toBe(true);
    expect(turnOptions?.message.rawBody).toBe("hello");
    expect(turnOptions?.message.bodyForAgent).toBe("hello");
    expect(turnOptions?.reply?.to).toBe("telegram:1234");
    expect(turnOptions?.reply?.originatingTo).toBeUndefined();
    expect(turnOptions?.reply?.replyToId).toBe("9");
    expect(turnOptions?.supplemental?.quote?.id).toBe("9");
    expect(turnOptions?.supplemental?.quote?.body).toBe("parent");
    expect(turnOptions?.supplemental?.quote?.sender).toBe("Bob");
    expect(turnOptions?.supplemental?.quote?.senderAllowed).toBe(true);
  });

  it("preserves voice-note source modality without treating ordinary audio as voice", async () => {
    const voiceCtx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        voice: { file_id: "voice-1" },
      },
    });
    const audioCtx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        audio: { file_id: "audio-1" },
      },
    });

    expect(voiceCtx?.ctxPayload.SourceModality).toBe("voice");
    expect(audioCtx?.ctxPayload.SourceModality).toBeUndefined();
  });

  it("does not pass threadId for regular DM without topic", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
      },
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram DM context payload");
    }
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ to: "telegram:1234" });
  });

  it("passes threadId to updateLastRoute for forum topic group messages", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group", is_forum: true },
        text: "@bot hello",
        message_thread_id: 99,
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram forum topic context payload");
    }
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ to: "telegram:-1001234567890:topic:99", threadId: "99" });
  });

  it("keeps the forum General topic target aligned with live routing", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group", is_forum: true },
        text: "@bot hello",
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram General topic context payload");
    }
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ to: "telegram:-1001234567890", threadId: "1" });
  });
});
