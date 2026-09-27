// Discord message processing coverage split by cohesive behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  BASE_CHANNEL_ROUTE,
  createAutomaticSourceDeliveryContext,
  createBaseContext,
  createDirectMessageContextOverrides,
  createNoQueuedDispatchResult,
  deliverDiscordReply,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  formatDiscordReplySkip,
  getLastDispatchCtx,
  getLastDispatchReplyOptions,
  logVerboseForTest as logVerbose,
  recordInboundSessionForTest as recordInboundSession,
  runProcessDiscordMessage,
  sleepWithAbortForTest as sleepWithAbort,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import { expectFreshFinalText, getReactionEmojis } from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

describe("processDiscordMessage deliver-lambda abort logging", () => {
  it("emits logVerbose with formatDiscordReplySkip when deliver fires on a pre-aborted signal", async () => {
    const verboseSpy = vi.mocked(logVerbose).mockImplementation(() => {});

    const abortController = new AbortController();
    // Abort after dispatch starts so the delivery boundary observes the cancelled turn.
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      abortController.abort();
      await params?.dispatcher.sendBlockReply({ text: "post-abort block payload" });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 1 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      abortSignal: abortController.signal,
      cfg: {
        messages: {
          ackReaction: "👀",
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    const dispatchedSessionKey = getLastDispatchCtx()?.SessionKey;
    expect(dispatchedSessionKey).toBeTypeOf("string");
    const expectedLog = formatDiscordReplySkip({
      kind: "block",
      reason: "aborted before delivery",
      target: "channel:c1",
      sessionKey: dispatchedSessionKey,
    });
    const verboseCalls = verboseSpy.mock.calls.map((call) => call[0]);
    expect(verboseCalls).toContain(expectedLog);
    verboseSpy.mockRestore();
  });
});

describe("processDiscordMessage thread binding activity failure", () => {
  it.each(["current", "aborted", "policy changed"] as const)(
    "continues only with the original inbound authority: %s",
    async (authority) => {
      const touchEntered = createDeferred<void>();
      const releaseTouch = createDeferred<void>();
      const abortController = new AbortController();
      let policyCurrent = true;
      const errorLog = vi.fn();
      const activityError = new Error("Discord thread binding changed during persistence");
      const ctx = await createAutomaticSourceDeliveryContext({
        abortSignal: abortController.signal,
        isPolicyCurrent: () => policyCurrent,
        runtime: { log: vi.fn(), error: errorLog },
        cfg: { messages: { statusReactions: { enabled: false } } },
        discordConfig: { streaming: { mode: "off" } },
      });
      ctx.threadBinding = {
        bindingId: "discord:default:c1",
        targetSessionKey: ctx.route.sessionKey,
        targetKind: "subagent",
        conversation: { channel: "discord", accountId: "default", conversationId: "c1" },
        status: "active",
        boundAt: 100,
      };
      const touchThread = vi.fn(async () => {
        touchEntered.resolve();
        await releaseTouch.promise;
        throw activityError;
      });
      ctx.threadBindings.touchThread = touchThread;
      dispatchInboundMessage.mockImplementation(async (params?: DispatchInboundParams) => {
        await params?.dispatcher.sendFinalReply({ text: "Still received your message." });
        return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
      });

      const processing = runProcessDiscordMessage(ctx);
      await touchEntered.promise;
      if (authority === "aborted") {
        abortController.abort();
      } else if (authority === "policy changed") {
        policyCurrent = false;
      }
      releaseTouch.resolve();
      await expect(processing).resolves.toBeUndefined();

      expect(touchThread).toHaveBeenCalledExactlyOnceWith({ threadId: "c1" });
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(activityError.message),
      );
      const expectedDispatches = authority === "current" ? 1 : 0;
      expect(recordInboundSession).toHaveBeenCalledTimes(expectedDispatches);
      expect(dispatchInboundMessage).toHaveBeenCalledTimes(expectedDispatches);
      expect(deliverDiscordReply).toHaveBeenCalledTimes(expectedDispatches);
      if (authority === "current") {
        expectFreshFinalText("Still received your message.");
      }
    },
  );
});

describe("processDiscordMessage reply session init conflict retry", () => {
  const conflictError = () =>
    new Error("reply session initialization conflicted for agent:main:discord:channel:c1");

  it("retries only dispatch while recording, acknowledging, and adding history once", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    dispatchInboundMessage
      .mockRejectedValueOnce(conflictError())
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce(createNoQueuedDispatchResult());
    const guildHistories = new Map();
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
        },
      },
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 250, undefined);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 1_000, undefined);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(getReactionEmojis()).toEqual(["👀"]);
    expect(guildHistories.get("c1")).toHaveLength(1);
    expect(guildHistories.get("c1")?.[0]).toMatchObject({
      body: "hi",
      messageId: "1001",
    });
    sleepSpy.mockRestore();
  });

  it.each([
    {
      name: "an automatic group request",
      visibleReplies: "automatic",
      inboundEventKind: "user_request",
      direct: false,
      expectedMode: "automatic",
      expectedSends: 1,
    },
    {
      name: "an ambient room event",
      visibleReplies: "automatic",
      inboundEventKind: "room_event",
      direct: false,
      expectedMode: "message_tool_only",
      expectedSends: 0,
    },
    {
      name: "a group request requiring the message tool",
      visibleReplies: "message_tool",
      inboundEventKind: "user_request",
      direct: false,
      expectedMode: "message_tool_only",
      expectedSends: 0,
    },
    {
      name: "a direct request despite the group message-tool policy",
      visibleReplies: "message_tool",
      inboundEventKind: "user_request",
      direct: true,
      expectedMode: "automatic",
      expectedSends: 1,
    },
  ] as const)("completes $name with a recorded terminal notice outcome", async (scenario) => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    const originalError = conflictError();
    dispatchInboundMessage.mockRejectedValue(originalError);
    const errorLog = vi.fn();

    const ctx = await createBaseContext({
      ...(scenario.direct ? createDirectMessageContextOverrides() : {}),
      inboundEventKind: scenario.inboundEventKind,
      shouldRequireMention: false,
      effectiveWasMentioned: scenario.inboundEventKind !== "room_event",
      cfg: { messages: { groupChat: { visibleReplies: scenario.visibleReplies } } },
      runtime: { log: vi.fn(), error: errorLog },
    });
    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(4);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 250, undefined);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 1_000, undefined);
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 2_500, undefined);
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe(scenario.expectedMode);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(scenario.expectedSends);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        `terminal notice ${scenario.expectedSends === 1 ? "delivered" : "suppressed"}`,
      ),
    );
    if (scenario.expectedSends === 1) {
      expectFreshFinalText(
        "⚠️ Couldn't process this message because the session stayed busy. Please try again in a moment.",
      );
    }
    sleepSpy.mockRestore();
  });

  it("records downstream suppression without claiming its terminal notice was delivered", async () => {
    dispatchInboundMessage.mockRejectedValue(conflictError());
    deliverDiscordReply.mockResolvedValueOnce({ visibleReplySent: false });
    const errorLog = vi.fn();
    const ctx = await createBaseContext({ runtime: { log: vi.fn(), error: errorLog } });

    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("terminal notice suppressed"),
    );
  });

  it("keeps exhaustion retryable when the visible failure notice cannot land", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    const originalError = conflictError();
    dispatchInboundMessage.mockRejectedValue(originalError);
    deliverDiscordReply.mockRejectedValueOnce(new Error("Discord unavailable"));

    const ctx = await createBaseContext();
    let thrown: unknown;
    try {
      await runProcessDiscordMessage(ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ cause: expect.any(Error) });
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(4);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    sleepSpy.mockRestore();
  });

  it("rebuilds a released replay without duplicating its pending history", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    dispatchInboundMessage.mockRejectedValueOnce(new Error("dispatch failed before completion"));
    const guildHistories = new Map();
    const createReplayContext = () =>
      createBaseContext({
        guildHistories,
        historyLimit: 10,
        inboundEventKind: "room_event",
      });

    await expect(runProcessDiscordMessage(await createReplayContext())).rejects.toBeInstanceOf(
      Error,
    );
    expect(guildHistories.get("c1")).toHaveLength(1);

    dispatchInboundMessage.mockResolvedValue(createNoQueuedDispatchResult());
    await runProcessDiscordMessage(await createReplayContext());

    expect(getLastDispatchCtx()?.Body).not.toContain("[Chat messages since your last reply");
    expect(guildHistories.get("c1")).toHaveLength(1);
    expect(guildHistories.get("c1")?.[0]?.messageId).toBe("1001");
    sleepSpy.mockRestore();
  });

  it("preserves unrelated dispatch errors", async () => {
    const originalError = new Error("some other dispatch error");
    dispatchInboundMessage.mockRejectedValueOnce(originalError);

    const ctx = await createBaseContext();
    await expect(runProcessDiscordMessage(ctx)).rejects.toBe(originalError);

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("treats an aborted conflict as cancellation", async () => {
    const abortController = new AbortController();
    dispatchInboundMessage.mockImplementationOnce(async () => {
      abortController.abort();
      throw conflictError();
    });

    const ctx = await createBaseContext({ abortSignal: abortController.signal });
    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });
});
