import {
  createOutboundPayloadPlan,
  isRecentOutboundMessageIdentity,
  recordOutboundMessageIdentity,
  projectOutboundPayloadPlanForDelivery,
} from "openclaw/plugin-sdk/channel-outbound";
import { dispatchReplyWithBufferedBlockDispatcher as dispatchThroughSharedOwner } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  createBot,
  createChannelMessageReplyPipeline,
  createContext,
  createDirectSessionPayload,
  createRuntime,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  describeStickerImage,
  dispatchTelegramMessage,
  dispatchWithContext,
  generateTopicLabel,
  getRunChannelInboundEventMock,
  loadSessionStore,
  requireInvocationOrder,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

function createMessageToolOnlyGroupContext(): TelegramMessageContext {
  return createContext({
    chatId: -1001234,
    isGroup: true,
    ctxPayload: {
      SessionKey: "agent:test:telegram:group:-1001234",
      ChatType: "group",
    } as TelegramMessageContext["ctxPayload"],
    primaryCtx: {
      message: { chat: { id: -1001234, type: "supergroup" } },
    } as TelegramMessageContext["primaryCtx"],
    msg: {
      chat: { id: -1001234, type: "supergroup" },
      message_id: 456,
    } as TelegramMessageContext["msg"],
    threadSpec: { id: undefined, scope: "none" },
    replyThreadId: undefined,
  });
}

describeTelegramDispatch("dispatchTelegramMessage fallback-topic-media", () => {
  it("uses resolved DM config for auto-topic-label overrides", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: true,
    });
    loadSessionStore.mockReturnValue({ s1: {} });
    const bot = createBot();

    await dispatchWithContext({
      bot,
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          RawBody: "Need help with invoices",
        } as TelegramMessageContext["ctxPayload"],
        groupConfig: {
          autoTopicLabel: false,
        } as TelegramMessageContext["groupConfig"],
      }),
      telegramCfg: { autoTopicLabel: true },
      cfg: {
        channels: {
          telegram: {
            direct: {
              "123": { autoTopicLabel: true },
            },
          },
        },
      },
    });

    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(bot.api["editForumTopic"]).not.toHaveBeenCalled();
  });

  it("truncates DM topic auto-rename input on UTF-16 boundaries", async () => {
    const sessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({
      [sessionKey]: { sessionId: "s1", updatedAt: 1 },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: true,
    });
    const bot = createBot();
    const base = "a".repeat(499);
    const rawBody = `${base}😀tail`;

    await dispatchWithContext({
      bot,
      context: createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          RawBody: rawBody,
        } as TelegramMessageContext["ctxPayload"],
      }),
      telegramCfg: { autoTopicLabel: true },
    });

    await vi.waitFor(() => {
      expect(generateTopicLabel).toHaveBeenCalled();
    });
    const call = generateTopicLabel.mock.calls[0]?.[0] as { userMessage: string };
    expect(call.userMessage).toBe(base);
  });

  it("does not emit a silent-reply fallback when the dispatcher reports a queued final reply", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: true,
      counts: { block: 0, final: 1, tool: 0 },
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("labels a DM topic whose first turn produced no visible response", async () => {
    const sessionKey = "agent:test:telegram:direct:123";
    loadSessionStore.mockReturnValue({ [sessionKey]: { sessionId: "s1", updatedAt: 1 } });
    // A completed pipeline can produce no visible answer.
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    generateTopicLabel.mockResolvedValue("Dentist appointment");
    const bot = createBot();
    const runtime = createRuntime();

    const result = await dispatchWithContext({
      bot,
      runtime,
      context: createContext({
        ctxPayload: {
          ...createDirectSessionPayload(),
          RawBody: "book me a dentist appointment",
        } as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "off",
      telegramCfg: { autoTopicLabel: true },
    });

    expect(result).toEqual({ kind: "completed" });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(generateTopicLabel).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: "book me a dentist appointment" }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    await vi.waitFor(
      () => {
        expect(bot.api["editForumTopic"]).toHaveBeenCalledOnce();
        expect(bot.api["editForumTopic"]).toHaveBeenCalledWith(123, 777, {
          name: "Dentist appointment",
        });
      },
      { timeout: 1_000, interval: 10 },
    );
  });

  it("labels a DM topic whose first turn is superseded mid-flight", async () => {
    const sessionKey = "agent:test:telegram:direct:123";
    loadSessionStore.mockReturnValue({ [sessionKey]: { sessionId: "s1", updatedAt: 1 } });
    const abortController = new AbortController();
    // The durable owner fences this attempt while the reply pipeline is running.
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async () => {
      abortController.abort(new Error("handler-timeout"));
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    generateTopicLabel.mockResolvedValue("Renew the domain");
    const bot = createBot();
    const runtime = createRuntime();

    const result = await dispatchWithContext({
      bot,
      runtime,
      context: createContext({
        ctxPayload: {
          ...createDirectSessionPayload(),
          RawBody: "remind me to renew the domain",
        } as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "off",
      telegramCfg: { autoTopicLabel: true },
      turnAdoptionLifecycle: {
        abortSignal: abortController.signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      },
    });

    expect(result).toEqual({ kind: "completed" });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(generateTopicLabel).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: "remind me to renew the domain" }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    await vi.waitFor(
      () => {
        expect(bot.api["editForumTopic"]).toHaveBeenCalledOnce();
        expect(bot.api["editForumTopic"]).toHaveBeenCalledWith(123, 777, {
          name: "Renew the domain",
        });
      },
      { timeout: 1_000, interval: 10 },
    );
  });

  it.each(["before dispatch", "during sticker preparation"] as const)(
    "does not label a first-turn DM topic fenced %s",
    async (abortAt) => {
      const sessionKey = "agent:test:telegram:direct:123";
      loadSessionStore.mockReturnValue({ [sessionKey]: { sessionId: "s1", updatedAt: 1 } });
      const abortController = new AbortController();
      const bot = createBot();
      const runtime = createRuntime();
      const context = createContext({
        ctxPayload: {
          ...createDirectSessionPayload(),
          RawBody: "book me a dentist appointment",
        } as TelegramMessageContext["ctxPayload"],
      });
      if (abortAt === "before dispatch") {
        abortController.abort(new Error("handler-timeout"));
      } else {
        context.ctxPayload.media = [{ path: "/tmp/sticker.webp", kind: "sticker" }];
        context.ctxPayload.Sticker = { fileId: "sticker-file", fileUniqueId: "sticker-unique" };
        describeStickerImage.mockImplementationOnce(async () => {
          abortController.abort(new Error("handler-timeout"));
          return null;
        });
      }

      await expect(
        dispatchWithContext({
          bot,
          runtime,
          context,
          streamMode: "off",
          telegramCfg: { autoTopicLabel: true },
          turnAdoptionLifecycle: {
            abortSignal: abortController.signal,
            onAdopted: vi.fn(),
            onDeferred: vi.fn(),
            onAbandoned: vi.fn(),
          },
        }),
      ).resolves.toEqual({ kind: "completed" });

      expect(describeStickerImage).toHaveBeenCalledTimes(abortAt === "before dispatch" ? 0 : 1);
      expect(createChannelMessageReplyPipeline).not.toHaveBeenCalled();
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
      expect(generateTopicLabel).not.toHaveBeenCalled();
      expect(bot.api["editForumTopic"]).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(deliverReplies).not.toHaveBeenCalled();
    },
  );

  it("does not label a DM topic when sticker preparation rejects before the pipeline", async () => {
    const sessionKey = "agent:test:telegram:direct:123";
    loadSessionStore.mockReturnValue({ [sessionKey]: { sessionId: "s1", updatedAt: 1 } });
    const preparationError = new Error("sticker preparation failed");
    describeStickerImage.mockRejectedValueOnce(preparationError);
    const bot = createBot();
    const runtime = createRuntime();
    const context = createContext({
      ctxPayload: {
        ...createDirectSessionPayload(),
        RawBody: "book me a dentist appointment",
        media: [{ path: "/tmp/sticker.webp", kind: "sticker" }],
        Sticker: { fileId: "sticker-file", fileUniqueId: "sticker-unique" },
      } as TelegramMessageContext["ctxPayload"],
    });

    await expect(
      dispatchWithContext({
        bot,
        runtime,
        context,
        streamMode: "off",
        telegramCfg: { autoTopicLabel: true },
      }),
    ).rejects.toBe(preparationError);

    expect(describeStickerImage).toHaveBeenCalledOnce();
    expect(createChannelMessageReplyPipeline).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(bot.api["editForumTopic"]).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not relabel an established DM topic after a no-response turn", async () => {
    const sessionKey = "agent:test:telegram:direct:123";
    loadSessionStore.mockReturnValue({
      [sessionKey]: { sessionId: "s1", updatedAt: 1, systemSent: true },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const bot = createBot();
    const runtime = createRuntime();

    await expect(
      dispatchWithContext({
        bot,
        runtime,
        context: createContext({
          ctxPayload: {
            ...createDirectSessionPayload(),
            RawBody: "book me a dentist appointment",
          } as TelegramMessageContext["ctxPayload"],
        }),
        streamMode: "off",
        telegramCfg: { autoTopicLabel: true },
      }),
    ).resolves.toEqual({ kind: "completed" });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(bot.api["editForumTopic"]).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("preserves the resolved DM opt-out after a no-response first turn", async () => {
    const sessionKey = "agent:test:telegram:direct:123";
    loadSessionStore.mockReturnValue({ [sessionKey]: { sessionId: "s1", updatedAt: 1 } });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const bot = createBot();
    const runtime = createRuntime();

    await expect(
      dispatchWithContext({
        bot,
        runtime,
        context: createContext({
          ctxPayload: {
            ...createDirectSessionPayload(),
            RawBody: "book me a dentist appointment",
          } as TelegramMessageContext["ctxPayload"],
          groupConfig: {
            autoTopicLabel: false,
          } as TelegramMessageContext["groupConfig"],
        }),
        streamMode: "off",
        telegramCfg: { autoTopicLabel: true },
      }),
    ).resolves.toEqual({ kind: "completed" });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(bot.api["editForumTopic"]).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("labels an accepted DM topic when the real SDK suppresses outbound echo dispatch", async () => {
    const sessionKey = "agent:test:telegram:direct:1317640135";
    const userMessage = "book me a dentist appointment";
    const identity = {
      channel: "telegram",
      accountId: "default",
      conversationId: "1317640135",
      messageId: "1317640135",
    };
    loadSessionStore.mockReturnValue({ [sessionKey]: { sessionId: "s1", updatedAt: 1 } });
    generateTopicLabel.mockResolvedValue("Dentist appointment");
    const bot = createBot();
    const sendMessage = vi.spyOn(bot.api, "sendMessage");
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    const runtime = createRuntime();
    const onAdopted = vi.fn(async () => undefined);
    const onDeferred = vi.fn();
    const onAbandoned = vi.fn();
    const dispatchReplyFromConfig =
      vi.fn<
        NonNullable<
          NonNullable<
            Parameters<typeof dispatchTelegramMessage>[0]["opts"]
          >["dispatchReplyFromConfig"]
        >
      >();
    const context = createContext({
      chatId: 1317640135,
      msg: {
        chat: { id: 1317640135, type: "private" },
        message_id: 1317640135,
        message_thread_id: 777,
      } as TelegramMessageContext["msg"],
      primaryCtx: {
        message: { chat: { id: 1317640135, type: "private" }, message_id: 1317640135 },
      } as TelegramMessageContext["primaryCtx"],
      route: {
        agentId: "test",
        accountId: "default",
        sessionKey,
      } as TelegramMessageContext["route"],
      ctxPayload: {
        ...createDirectSessionPayload(),
        SessionKey: sessionKey,
        NativeChannelId: identity.conversationId,
        MessageSid: identity.messageId,
        RawBody: userMessage,
      } as TelegramMessageContext["ctxPayload"],
    });
    // Keep Telegram's real adapter and the SDK's routed lifecycle intact.
    // "Accepted" means Telegram supplied a context, not SDK admission.kind=dispatch:
    // the execution owner recognizes the recorded echo and adopts without dispatch.
    const actualInbound = await vi.importActual<
      typeof import("openclaw/plugin-sdk/channel-inbound")
    >("openclaw/plugin-sdk/channel-inbound");
    // The serial row borrows the existing symbol-backed Map, not a replacement
    // module instance. Preserve its entries/order: recording can prune or evict.
    // There is no expiry timer, and resetModules does not retire this state.
    const sharedEchoState: unknown = Reflect.get(
      globalThis,
      Symbol.for("openclaw.outboundMessageIdentities"),
    );
    if (!(sharedEchoState instanceof Map)) {
      throw new Error("Expected the loaded outbound echo state");
    }
    const echoIdentities: Map<unknown, unknown> = sharedEchoState;
    const savedEchoEntries = [...echoIdentities];
    // Borrow the exact mock function captured by the adapter's harness.
    const runInbound = getRunChannelInboundEventMock();
    runInbound.mockClear();
    try {
      // Call through without reparenting the real SDK function's prototype.
      runInbound.mockImplementationOnce((params) => actualInbound.runChannelInboundEvent(params));
      echoIdentities.clear();
      expect(isRecentOutboundMessageIdentity(identity)).toBe(false);
      recordOutboundMessageIdentity(identity);
      expect(isRecentOutboundMessageIdentity(identity)).toBe(true);

      await expect(
        dispatchWithContext({
          bot,
          runtime,
          context,
          streamMode: "off",
          telegramCfg: { autoTopicLabel: true },
          opts: { token: "token", dispatchReplyFromConfig },
          turnAdoptionLifecycle: { onAdopted, onDeferred, onAbandoned },
        }),
      ).resolves.toEqual({ kind: "completed" });

      expect(runInbound).toHaveBeenCalledOnce();
      await expect(runInbound.mock.results[0]?.value).resolves.toMatchObject({
        admission: { kind: "drop", reason: "outbound-echo" },
        dispatched: false,
        ctxPayload: context.ctxPayload,
        routeSessionKey: sessionKey,
      });
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(onDeferred).not.toHaveBeenCalled();
      expect(onAbandoned).not.toHaveBeenCalled();
      expect(createChannelMessageReplyPipeline).toHaveBeenCalledOnce();
      expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(deliverReplies).not.toHaveBeenCalled();
      expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(generateTopicLabel).toHaveBeenCalledOnce();
      expect(generateTopicLabel).toHaveBeenCalledWith(
        expect.objectContaining({ userMessage, agentId: "test" }),
      );
      expect(requireInvocationOrder(onAdopted, 0, "echo adoption")).toBeLessThan(
        requireInvocationOrder(generateTopicLabel, 0, "topic label scheduling"),
      );
      await vi.waitFor(
        () => {
          expect(editForumTopic).toHaveBeenCalledOnce();
          expect(editForumTopic).toHaveBeenCalledWith(1317640135, 777, {
            name: "Dentist appointment",
          });
        },
        { timeout: 1_000, interval: 10 },
      );
    } finally {
      // Retire this row's identity on success, rejection, or assertion failure,
      // then restore the same Map and every borrowed entry without waiting.
      echoIdentities.clear();
      for (const [key, expiresAt] of savedEchoEntries) {
        echoIdentities.set(key, expiresAt);
      }
      runInbound.mockRestore();
      editForumTopic.mockRestore();
      sendMessage.mockRestore();
    }
  });

  it.each([
    { name: "disabled DM access", dmPolicy: "disabled" as const, requireTopic: false },
    { name: "required DM topic missing", dmPolicy: "open" as const, requireTopic: true },
  ])(
    "does not label at the real processor entry after $name",
    async ({ dmPolicy, requireTopic }) => {
      const { createTelegramMessageProcessor } = await import("./bot-message.js");
      const { runWithTelegramUpdateProcessingFrame } = await import("./bot-processing-outcome.js");
      const dmAccess = await import("./dm-access.js");
      const groupAccess = await import("./group-access.js");
      const enforceDmAccess = vi.spyOn(dmAccess, "enforceTelegramDmAccess");
      const checkBaseAccess = vi.spyOn(groupAccess, "evaluateTelegramGroupBaseAccess");
      const bot = createBot();
      const sendMessage = vi.spyOn(bot.api, "sendMessage");
      const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
      try {
        const runtime = createRuntime();
        const onDispatchStart = vi.fn(async () => undefined);
        const resolveGroupConfig = vi.fn<
          Parameters<typeof createTelegramMessageProcessor>[0]["resolveTelegramGroupConfig"]
        >(() => ({
          groupConfig: { requireTopic, autoTopicLabel: true },
          topicConfig: undefined,
        }));
        const telegramCfg = { dmPolicy, allowFrom: ["*"], autoTopicLabel: true };
        const cfg = { channels: { telegram: telegramCfg } };
        const processor = createTelegramMessageProcessor({
          bot,
          account: { accountId: "default" },
          groupHistories: new Map(),
          logger: {
            info: vi.fn<Parameters<typeof createTelegramMessageProcessor>[0]["logger"]["info"]>(),
          },
          resolveGroupActivation: () => undefined,
          resolveGroupRequireMention: () => false,
          resolveTelegramGroupConfig: resolveGroupConfig,
          sendChatActionHandler: {
            sendChatAction: vi.fn(async () => undefined),
            isSuspended: () => false,
            reset: vi.fn(),
          },
          runtime,
          telegramDeps: telegramDepsForTest,
          opts: { token: "token" },
        });
        const primaryCtx: Parameters<typeof processor>[0] = {
          ...createContext().primaryCtx,
          message: {
            chat: { id: 123, type: "private", first_name: "Test" },
            message_id: 456,
            date: 1,
            from: { id: 123, is_bot: false, first_name: "Test" },
            text: "book me a dentist appointment",
            ...(requireTopic ? {} : { message_thread_id: 777, is_topic_message: true }),
          },
        };

        await expect(
          runWithTelegramUpdateProcessingFrame(() =>
            processor(primaryCtx, [], [], { cfg, telegramCfg, onDispatchStart }),
          ),
        ).resolves.toEqual({ value: { kind: "skipped" }, result: { kind: "skipped" } });
        // A subsequent independent update must not inherit this terminal result.
        await expect(runWithTelegramUpdateProcessingFrame(async () => undefined)).resolves.toEqual({
          value: undefined,
        });

        expect(resolveGroupConfig).toHaveBeenCalledOnce();
        expect(resolveGroupConfig).toHaveBeenCalledWith(123, requireTopic ? undefined : 777, cfg);
        // Both controls must pass the preceding access gate, not accidentally skip there.
        expect(checkBaseAccess).toHaveBeenCalledOnce();
        expect(checkBaseAccess.mock.results[0]?.value).toMatchObject({ allowed: true });
        if (dmPolicy === "disabled") {
          expect(enforceDmAccess).toHaveBeenCalledOnce();
          expect(enforceDmAccess).toHaveBeenCalledWith(
            expect.objectContaining({ isGroup: false, dmPolicy: "disabled", chatId: 123 }),
          );
          await expect(enforceDmAccess.mock.results[0]?.value).resolves.toBe(false);
        } else {
          // The required-topic check is between base access and DM enforcement.
          expect(enforceDmAccess).not.toHaveBeenCalled();
        }
        expect(onDispatchStart).not.toHaveBeenCalled();
        expect(createChannelMessageReplyPipeline).not.toHaveBeenCalled();
        expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
        expect(generateTopicLabel).not.toHaveBeenCalled();
        expect(editForumTopic).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(deliverReplies).not.toHaveBeenCalled();
        expect(runtime.error).not.toHaveBeenCalled();
      } finally {
        editForumTopic.mockRestore();
        sendMessage.mockRestore();
        checkBaseAccess.mockRestore();
        enforceDmAccess.mockRestore();
      }
    },
  );

  it("does not emit a silent-reply fallback for no-response DM turns", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit an empty-response fallback for internal artifact skips", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "<channel|>" }, { kind: "final", reason: "silent" });
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit an empty-response fallback for message-tool-only delivery skips", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({}, { kind: "final", reason: "empty" });
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
      };
    });

    await dispatchWithContext({
      context: createMessageToolOnlyGroupContext(),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "honors send-policy denial when fallback delivery fails=%s",
    async (deliveryFailed) => {
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        dispatcherOptions.onSkip?.({}, { kind: "final", reason: "empty" });
        if (deliveryFailed) {
          await dispatcherOptions.onError?.(new Error("Final delivery failed"), { kind: "final" });
        }
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sendPolicyDenied: true,
        };
      });

      await dispatchWithContext({
        cfg: { messages: { groupChat: { visibleReplies: "automatic" } } },
        context: createMessageToolOnlyGroupContext(),
        streamMode: "off",
      });

      expect(deliverReplies).not.toHaveBeenCalled();
    },
  );

  it("retains the failure fallback when message-tool-only delivery also fails", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({}, { kind: "final", reason: "empty" });
      await dispatcherOptions.onError?.(new Error("Telegram final delivery failed"), {
        kind: "final",
      });
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
      };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).toHaveBeenCalledOnce();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "No response generated. Please try again." }],
      }),
    );
  });

  it("delivers exactly one replay fallback when the provider fails before visible output", async () => {
    const providerError = new Error("provider returned HTTP 500");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async (params) =>
      dispatchThroughSharedOwner({
        ...params,
        replyResolver: async (_ctx, options) => {
          options?.onAgentRunTerminalOutcome?.("failed");
          throw providerError;
        },
      }),
    );

    await dispatchWithContext({
      cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      context: createMessageToolOnlyGroupContext(),
      retryDispatchErrors: true,
      streamMode: "off",
      suppressFailureFallback: true,
      telegramCfg: { silentErrorReplies: true },
    });

    expect(deliverReplies).toHaveBeenCalledOnce();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        silent: true,
        replies: [
          {
            text: "Something went wrong while processing your request. Please try again.",
          },
        ],
      }),
    );
  });

  it("does not emit a silent-reply fallback for no-response group turns", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({
      context: createContext({
        chatId: -1001234,
        isGroup: true,
        ctxPayload: {
          SessionKey: "agent:test:telegram:group:-1001234",
          ChatType: "group",
        } as TelegramMessageContext["ctxPayload"],
        primaryCtx: {
          message: { chat: { id: -1001234, type: "supergroup" } },
        } as TelegramMessageContext["primaryCtx"],
        msg: {
          chat: { id: -1001234, type: "supergroup" },
          message_id: 456,
        } as TelegramMessageContext["msg"],
        threadSpec: { id: undefined, scope: "none" },
        replyThreadId: undefined,
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              group: "disallow",
              internal: "allow",
            },
          },
        },
      } as Parameters<typeof dispatchTelegramMessage>[0]["cfg"],
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("recovers a directed turn when shared dispatch marks the empty fallback eligible", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      noVisibleReplyFallbackEligible: true,
    });

    await dispatchWithContext({
      context: createContext({
        chatId: -1001234,
        isGroup: true,
        ctxPayload: {
          SessionKey: "agent:test:telegram:group:-1001234",
          ChatType: "group",
        } as TelegramMessageContext["ctxPayload"],
        primaryCtx: {
          message: { chat: { id: -1001234, type: "supergroup" } },
        } as TelegramMessageContext["primaryCtx"],
        msg: {
          chat: { id: -1001234, type: "supergroup" },
          message_id: 456,
        } as TelegramMessageContext["msg"],
        threadSpec: { id: undefined, scope: "none" },
        replyThreadId: undefined,
      }),
      streamMode: "off",
    });

    expect(deliverReplies).toHaveBeenCalledOnce();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "No response generated. Please try again." }],
      }),
    );
  });

  describe("non-streaming media dedup", () => {
    const finalDeliveryPayload = () => {
      for (const [params] of deliverInboundReplyWithMessageSendContext.mock.calls) {
        if (params.info.kind === "final") {
          return params.payload;
        }
      }
      throw new Error("missing final delivery");
    };

    it("deduplicates block-sent media from final reply", async () => {
      deliverReplies.mockResolvedValue({ delivered: true });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["101"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ mediaUrls: ["/tmp/cat.jpg"] }, { kind: "block" });
        await dispatcherOptions.deliver(
          { text: "Here is the image", mediaUrls: ["/tmp/cat.jpg"] },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
      });

      expect(finalDeliveryPayload().mediaUrls).toEqual([]);
    });

    it("does not restore block-sent legacy media when the final includes another attachment", async () => {
      const sentMediaUrl = "/tmp/cat.jpg";
      const remainingMediaUrl = "/tmp/dog.jpg";
      deliverReplies.mockResolvedValue({ delivered: true });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["101"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ mediaUrl: sentMediaUrl }, { kind: "block" });
        await dispatcherOptions.deliver(
          {
            text: "Here are the images",
            mediaUrls: [remainingMediaUrl],
            mediaUrl: sentMediaUrl,
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
      });

      const finalPayload = finalDeliveryPayload();
      expect(finalPayload).toMatchObject({
        text: "Here are the images",
        mediaUrl: undefined,
        mediaUrls: [remainingMediaUrl],
      });
      expect(
        projectOutboundPayloadPlanForDelivery(createOutboundPayloadPlan([finalPayload]))[0]
          ?.mediaUrls,
      ).toEqual([remainingMediaUrl]);
    });

    it("preserves final media when block delivery reports no visible send", async () => {
      deliverReplies.mockResolvedValueOnce({ delivered: false });
      deliverReplies.mockResolvedValue({ delivered: true });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["101"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ mediaUrls: ["/tmp/cat.jpg"] }, { kind: "block" });
        await dispatcherOptions.deliver(
          { text: "Here is the image", mediaUrls: ["/tmp/cat.jpg"] },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
      });

      expect(finalDeliveryPayload().mediaUrls).toEqual(["/tmp/cat.jpg"]);
    });

    it("preserves final media when block delivery fails", async () => {
      deliverReplies.mockRejectedValueOnce(new Error("Telegram API error"));
      deliverReplies.mockResolvedValue({ delivered: true });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["101"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        try {
          await dispatcherOptions.deliver({ mediaUrls: ["/tmp/cat.jpg"] }, { kind: "block" });
        } catch {}
        await dispatcherOptions.deliver(
          { text: "Here is the image", mediaUrls: ["/tmp/cat.jpg"] },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
      });

      expect(finalDeliveryPayload().mediaUrls).toEqual(["/tmp/cat.jpg"]);
    });
  });
});
