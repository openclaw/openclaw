import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { clearGroupNameCache, handleFeishuMessage } from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

// Regression coverage for issue #50490: switching a Feishu group from
// `mentionRequired: false` to `/activation mention` via the runtime command
// must immediately gate non-@ messages. The shared command handler in
// `src/auto-reply/reply/commands-session.ts` stores `groupActivation` on the
// session entry; the Feishu admission gate has to consult it in addition to
// the static config flag (Telegram and WhatsApp already do this).

const { mockCreateFeishuReplyDispatcher, mockCreateFeishuClient, mockResolveAgentRoute } =
  vi.hoisted(() => ({
    mockCreateFeishuReplyDispatcher: vi.fn((_params?: unknown) => ({
      dispatcher: {
        sendToolResult: vi.fn(),
        sendBlockReply: vi.fn(),
        sendFinalReply: vi.fn(),
        waitForIdle: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    })),
    mockCreateFeishuClient: vi.fn(() => ({
      contact: {
        user: { get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }) },
      },
      im: {
        chat: {
          get: vi.fn().mockResolvedValue({ code: 0, data: { name: "Group" } }),
        },
      },
    })),
    mockResolveAgentRoute: vi.fn(),
  }));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
}

describe("Feishu group activation session override (#50490)", () => {
  const dispatched: Array<Record<string, unknown>> = [];
  let tmpStateDir: string;
  let sessionStorePath: string;

  const mockFinalizeInboundContext: PluginRuntime["channel"]["reply"]["finalizeInboundContext"] = (
    ctx,
  ) => {
    dispatched.push(ctx);
    return {
      ...ctx,
      CommandAuthorized: typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : false,
      CommandTurn: { kind: "normal", source: "message", authorized: false },
    };
  };
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
  const mockWithReplyDispatcher: PluginRuntime["channel"]["reply"]["withReplyDispatcher"] = async ({
    dispatcher,
    run,
    onSettled,
  }) => {
    try {
      return await run();
    } finally {
      dispatcher.markComplete();
      try {
        await dispatcher.waitForIdle();
      } finally {
        await onSettled?.();
      }
    }
  };
  const resolveEnvelopeFormatOptionsMock: PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"] =
    () => ({}) satisfies EnvelopeFormatOptions;

  const runtimeStub = {
    system: { enqueueSystemEvent: vi.fn() },
    channel: {
      routing: {
        resolveAgentRoute: (params: unknown) => mockResolveAgentRoute(params),
      },
      session: {
        resolveStorePath: ((..._args: unknown[]) =>
          sessionStorePath) as unknown as PluginRuntime["channel"]["session"]["resolveStorePath"],
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
        readSessionUpdatedAt: vi.fn(() => undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: resolveEnvelopeFormatOptionsMock,
        formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
        finalizeInboundContext: mockFinalizeInboundContext,
        dispatchReplyFromConfig: mockDispatchReplyFromConfig,
        withReplyDispatcher: mockWithReplyDispatcher,
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
      media: {
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: "/tmp/inbound-clip.mp4",
          contentType: "video/mp4",
        }),
      },
      inbound: {
        run: vi.fn(async (params: Parameters<PluginRuntime["channel"]["inbound"]["run"]>[0]) => {
          const input = await params.adapter.ingest(params.raw);
          if (!input) {
            return {
              admission: { kind: "drop" as const, reason: "ingest-null" },
              dispatched: false,
            };
          }
          const eventClass = { kind: "message" as const, canStartAgentTurn: true };
          const turn = await params.adapter.resolveTurn(input, eventClass, {});
          if (!("runDispatch" in turn)) {
            throw new Error("activation-override test runtime only supports prepared turns");
          }
          await turn.recordInboundSession({
            storePath: turn.storePath,
            sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
            ctx: turn.ctxPayload,
            groupResolution: turn.record?.groupResolution,
            createIfMissing: turn.record?.createIfMissing,
            updateLastRoute: turn.record?.updateLastRoute,
            onRecordError: turn.record?.onRecordError ?? (() => undefined),
          });
          return {
            admission: { kind: "dispatch" as const },
            dispatched: true,
            ctxPayload: turn.ctxPayload,
            routeSessionKey: turn.routeSessionKey,
            dispatchResult: await turn.runDispatch(),
          };
        }),
      },
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue([]),
        upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
        buildPairingReply: vi.fn(() => "Pairing response"),
      },
    },
    media: { detectMime: vi.fn(async () => "application/octet-stream") },
  } as unknown as PluginRuntime;

  function createOpenGroupConfig(): ClawdbotConfig {
    return {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groupPolicy: "open",
          // Static config admits every group message. The session-level
          // `/activation mention` override must still kick in.
          requireMention: false,
        },
      },
    };
  }

  function createMentionRequiredGroupConfig(): ClawdbotConfig {
    return {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groupPolicy: "open",
          requireMention: true,
        },
      },
    };
  }

  function createInboundEvent(options: {
    messageId: string;
    mentioned: boolean;
  }): FeishuMessageEvent {
    return {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: options.messageId,
        chat_id: "oc-activation-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: options.mentioned ? "@bot hello" : "hello" }),
        ...(options.mentioned
          ? {
              mentions: [
                {
                  key: "@_user_1",
                  id: { open_id: "bot-open-id" },
                  name: "Bot",
                  tenant_key: "",
                },
              ],
            }
          : {}),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearGroupNameCache();
    dispatched.length = 0;
    tmpStateDir = mkdtempSync(join(tmpdir(), "feishu-activation-"));
    sessionStorePath = join(tmpStateDir, "sessions.json");
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:group:oc-activation-group",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
    setFeishuRuntime(runtimeStub);
  });

  afterEach(() => {
    rmSync(tmpStateDir, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.doUnmock("./reply-dispatcher.js");
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  function writeSessionActivation(activation: "mention" | "always" | undefined) {
    const entry =
      activation === undefined
        ? {}
        : { "agent:main:feishu:group:oc-activation-group": { groupActivation: activation } };
    writeFileSync(sessionStorePath, JSON.stringify(entry), "utf-8");
  }

  it("drops non-mentioned group messages once /activation mention is recorded on the session entry", async () => {
    // Reproduces #50490. With `mentionRequired: false` the config-only gate
    // would admit every message, but the runtime override must trump it.
    // We assert that the gate returns early — `inbound.run` is not even
    // entered, so `finalizeInboundContext` / `dispatchReplyFromConfig` stay
    // untouched. Admission of @-mentioned messages keeps working because the
    // override only flips `requireMention`, not anything downstream — that is
    // covered by the existing `handleFeishuMessage` suite.
    writeSessionActivation("mention");

    await handleFeishuMessage({
      cfg: createOpenGroupConfig(),
      event: createInboundEvent({ messageId: "msg-no-mention", mentioned: false }),
      runtime: createRuntimeEnv(),
    });

    expect(dispatched).toHaveLength(0);
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("admits non-mentioned group messages once /activation always is recorded on the session entry", async () => {
    // Covers the inverse override: static config requires @-mentions, but the
    // runtime session switch must force the group back to always-on admission.
    writeSessionActivation("always");

    await handleFeishuMessage({
      cfg: createMentionRequiredGroupConfig(),
      event: createInboundEvent({ messageId: "msg-always-no-mention", mentioned: false }),
      runtime: createRuntimeEnv(),
    });

    expect(dispatched).toHaveLength(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });
});
