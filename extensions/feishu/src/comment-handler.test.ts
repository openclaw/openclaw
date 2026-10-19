import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import { setFeishuRuntime } from "./runtime.js";
import type { FeishuConfig } from "./types.js";

const resolveDriveCommentEventTurnMock = vi.hoisted(() => vi.fn());
const createFeishuCommentReplyDispatcherMock = vi.hoisted(() => vi.fn());
const maybeCreateDynamicAgentMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn(() => ({ request: vi.fn() })));
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const dispatchInboundMessageMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor.comment.js", () => ({
  resolveDriveCommentEventTurn: resolveDriveCommentEventTurnMock,
}));

vi.mock("./comment-dispatcher.js", () => ({
  createFeishuCommentReplyDispatcher: createFeishuCommentReplyDispatcherMock,
}));

// mock-isolation: comment dispatch must not create real dynamic agents.
vi.mock("./dynamic-agent.js", () => ({ maybeCreateDynamicAgent: maybeCreateDynamicAgentMock }));
// mock-isolation: comment dispatch uses a synthetic client, without network access.
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
// mock-isolation: capture comment delivery without calling the remote drive API.
vi.mock("./drive.js", () => ({ deliverCommentThreadText: deliverCommentThreadTextMock }));

async function raceWithNextMacrotask<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

function buildConfig(overrides: Partial<FeishuConfig> = {}): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        ...overrides,
      },
    },
  } as ClawdbotConfig;
}

let currentRuntimeConfig = buildConfig();

function buildResolvedRoute(matchedBy: "binding.channel" | "default" = "binding.channel") {
  return {
    agentId: "main",
    accountId: "default",
    sessionKey: "agent:main:feishu:direct:ou_sender",
    matchedBy,
  };
}

function useRuntime(
  currentCfg = currentRuntimeConfig,
  matchedBy: "binding.channel" | "default" = "default",
) {
  const recordInboundSession = vi.fn(async (_params: unknown) => {});
  type CommentTurnPlan = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];
  const dispatchPlanForTest = vi.fn(async (turn: CommentTurnPlan) => {
    await recordInboundSession({
      storePath: "/tmp/feishu-session-store.json",
      sessionKey: turn.ctxPayload.SessionKey ?? turn.route.sessionKey,
      ctx: turn.ctxPayload,
      groupResolution: turn.record?.groupResolution,
      createIfMissing: turn.record?.createIfMissing,
      updateLastRoute: turn.record?.updateLastRoute,
      onRecordError: turn.record?.onRecordError ?? (() => undefined),
    });
    const dispatchResult = await dispatchInboundMessageMock({
      ctx: turn.ctxPayload,
      cfg: turn.cfg,
      replyOptions: turn.replyOptions,
    });
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.route.sessionKey,
      dispatchResult,
    };
  });

  const runtime = {
    config: { current: vi.fn(() => currentCfg) },
    channel: {
      routing: {
        buildAgentSessionKey: vi.fn(
          ({
            agentId,
            channel,
            peer,
          }: Parameters<PluginRuntime["channel"]["routing"]["buildAgentSessionKey"]>[0]) =>
            `agent:${agentId}:${channel}:${peer?.kind ?? "direct"}:${peer?.id ?? "peer"}`,
        ),
        resolveAgentRoute: vi.fn(() => buildResolvedRoute(matchedBy)),
      },
      session: { recordInboundSession },
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        buildContext: buildChannelInboundEventContext,
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
          if (!("route" in turn) || !("delivery" in turn)) {
            throw new Error("expected assembled Feishu comment turn plan");
          }
          return await dispatchPlanForTest(turn);
        }) as unknown as PluginRuntime["channel"]["inbound"]["run"],
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "TESTCODE", created: true })),
      },
    },
  } as unknown as PluginRuntime;
  setFeishuRuntime(runtime);
  return runtime;
}

function mockDispatcher(cleanupTypingReaction = vi.fn(async () => {})) {
  createFeishuCommentReplyDispatcherMock.mockReturnValue({
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    cleanupTypingReaction,
  });
}

function handleComment(overrides: Partial<Parameters<typeof handleFeishuCommentEvent>[0]> = {}) {
  return handleFeishuCommentEvent({
    cfg: buildConfig(),
    accountId: "default",
    event: { event_id: "evt_1" },
    botOpenId: "ou_bot",
    runtime: { log: vi.fn(), error: vi.fn() } as never,
    ...overrides,
  });
}

describe("handleFeishuCommentEvent", () => {
  afterAll(() => {
    vi.doUnmock("./monitor.comment.js");
    vi.doUnmock("./comment-dispatcher.js");
    vi.doUnmock("./dynamic-agent.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("./drive.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    currentRuntimeConfig = buildConfig();
    maybeCreateDynamicAgentMock.mockImplementation(async ({ cfg }) => ({
      created: false,
      updatedCfg: cfg,
    }));
    resolveDriveCommentEventTurnMock.mockResolvedValue({
      eventId: "evt_1",
      messageId: "drive-comment:evt_1",
      commentId: "comment_1",
      replyId: "reply_1",
      noticeType: "add_comment",
      fileToken: "doc_token_1",
      fileType: "docx",
      isWholeComment: false,
      senderId: "ou_sender",
      senderUserId: "on_sender_user",
      timestamp: "1774951528000",
      isMentioned: true,
      documentTitle: "Project review",
      prompt: "prompt body",
      preview: "prompt body",
      rootCommentText: "root comment",
      targetReplyText: "latest reply",
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "r1",
    });

    useRuntime(currentRuntimeConfig, "binding.channel");

    mockDispatcher();
  });

  it("records a comment-thread inbound context with a routable Feishu origin", async () => {
    const runtime = useRuntime(currentRuntimeConfig, "binding.channel");
    const abortController = new AbortController();
    await handleComment({
      abortSignal: abortController.signal,
    });

    expect(resolveDriveCommentEventTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: abortController.signal }),
    );

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchInboundMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          From: "feishu:ou_sender",
          To: "comment:docx:doc_token_1:comment_1",
          Surface: "feishu-comment",
          OriginatingChannel: "feishu",
          OriginatingTo: "comment:docx:doc_token_1:comment_1",
          MessageSid: "drive-comment:evt_1",
          MessageThreadId: "reply_1",
        }),
      }),
    );
    expect(runtime.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
    expect(runtime.channel.session.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:feishu:direct:comment-doc:docx:doc_token_1",
      }),
    );
  });

  it("allows comment senders matched by user_id allowlist entries", async () => {
    await handleComment({
      cfg: buildConfig({ dmPolicy: "allowlist", allowFrom: ["on_sender_user"] }),
    });

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
  });

  it("passes the resolved account to dynamic agent resolution", async () => {
    const cfg = buildConfig({
      configWrites: false,
      dynamicAgentCreation: { enabled: true },
    });
    useRuntime(cfg);
    await handleComment({ cfg });

    expect(maybeCreateDynamicAgentMock).toHaveBeenCalledTimes(1);
    expect(maybeCreateDynamicAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ senderOpenId: "ou_sender", accountId: "default" }),
    );
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  });

  it("drops a comment denied by refreshed dynamic-agent policy", async () => {
    const refreshedCfg = buildConfig({ dmPolicy: "allowlist", allowFrom: ["ou_admin"] });
    useRuntime(refreshedCfg);
    await handleComment();

    expect(maybeCreateDynamicAgentMock).not.toHaveBeenCalled();
    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge before dynamic comment-agent creation", async () => {
    const currentCfg = buildConfig({
      dmPolicy: "pairing",
      allowFrom: [],
      dynamicAgentCreation: { enabled: true },
    });
    useRuntime(currentCfg);

    await handleComment();

    expect(maybeCreateDynamicAgentMock).not.toHaveBeenCalled();
    expect(deliverCommentThreadTextMock).toHaveBeenCalledTimes(1);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge in the comment thread when dmPolicy=pairing", async () => {
    const log = vi.fn();
    await handleComment({
      runtime: { log, error: vi.fn(), exit: vi.fn() },
      cfg: buildConfig({ dmPolicy: "pairing", allowFrom: [] }),
    });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledTimes(1);
    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      createFeishuClientMock.mock.results[0]?.value,
      {
        file_token: "doc_token_1",
        file_type: "docx",
        comment_id: "comment_1",
        content:
          "OpenClaw: access not configured.\n\nYour Feishu user id: ou_sender\nPairing code:\n```\nTESTCODE\n```\n\nAsk the bot owner to approve with:\n```\nopenclaw pairing approve feishu TESTCODE\n```",
        is_whole_comment: false,
      },
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("TESTCODE");
    expect(log).toHaveBeenCalledWith("feishu[default]: comment pairing request sender=ou_sender");
  });

  it("always finalizes comment typing cleanup even when dispatch fails", async () => {
    dispatchInboundMessageMock.mockRejectedValueOnce(new Error("dispatch failed"));
    const cleanupTypingReaction = vi.fn(async () => {});
    mockDispatcher(cleanupTypingReaction);

    await expect(handleComment()).rejects.toThrow("dispatch failed");

    expect(cleanupTypingReaction).toHaveBeenCalledTimes(1);
  });

  it("does not wait for comment typing cleanup before returning", async () => {
    let resolveCleanup: (() => void) | undefined;
    const cleanupTypingReaction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    mockDispatcher(cleanupTypingReaction);

    const eventPromise = handleComment();

    const status = await raceWithNextMacrotask(eventPromise.then(() => "done"));

    expect(status).toBe("done");
    expect(cleanupTypingReaction).toHaveBeenCalledTimes(1);

    resolveCleanup?.();
    await eventPromise;
  });
});
