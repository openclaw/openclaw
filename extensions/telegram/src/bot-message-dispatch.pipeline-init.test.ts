import { createStatusReactionController as createRealStatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  createChannelMessageReplyPipeline,
  createContext,
  createRuntime,
  createStatusReactionController,
  dispatchReplyWithBufferedBlockDispatcher,
  describeStickerImage,
  describeTelegramDispatch,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";

describeTelegramDispatch("dispatchTelegramMessage pipeline-init", () => {
  it("awaits routed session metadata persistence before ordinary message dispatch", async () => {
    const context = createContext();
    const sessionKey = "agent:main:telegram:group:-42001:topic:42";
    context.route.sessionKey = sessionKey;
    context.ctxPayload = {
      ...context.ctxPayload,
      RawBody: "Check this please",
      BodyForAgent: "Check this please",
      SessionKey: sessionKey,
      Provider: "telegram",
      OriginatingChannel: "telegram",
    };
    const recorded = createDeferred<void>();
    const metadata = createDeferred<void>();
    const recordInboundSession = vi.fn<typeof context.turn.recordInboundSession>(
      async ({ trackSessionMetaTask }) => {
        trackSessionMetaTask?.(metadata.promise);
        recorded.resolve();
      },
    );
    context.turn.recordInboundSession = recordInboundSession;
    const work = dispatchWithContext({ context, streamMode: "off" });
    try {
      await recorded.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    } finally {
      metadata.resolve();
      await work;
    }
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        ctx: expect.objectContaining(context.ctxPayload),
      }),
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("keeps the owning Gateway reply dispatcher on the assembled inbound turn", async () => {
    const dispatchReplyFromConfig = vi.fn();

    await dispatchWithContext({
      context: createContext(),
      opts: {
        token: "token",
        dispatchReplyFromConfig,
      } as Parameters<typeof dispatchWithContext>[0]["opts"],
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchReplyFromConfig }),
    );
  });

  it.each(["before dispatch", "during sticker preparation"] as const)(
    "stops queued status reactions when the durable owner aborts %s",
    async (abortAt) => {
      vi.useFakeTimers();
      const setReaction = vi.fn(async (_emoji: string) => undefined);
      const controller = createRealStatusReactionController({
        enabled: true,
        adapter: { setReaction },
        initialEmoji: "👀",
      });
      try {
        // Context assembly queues the acknowledgement before dispatch preparation.
        await controller.setQueued();
        await vi.advanceTimersByTimeAsync(0);
        expect(setReaction).toHaveBeenCalledWith("👀");
        const abortController = new AbortController();
        const context = createContext({ statusReactionController: controller });
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
            context,
            streamMode: "off",
            turnAdoptionLifecycle: {
              abortSignal: abortController.signal,
              onAdopted: vi.fn(),
              onDeferred: vi.fn(),
              onAbandoned: vi.fn(),
            },
          }),
        ).resolves.toEqual({ kind: "completed" });
        expect(createChannelMessageReplyPipeline).not.toHaveBeenCalled();
        expect(describeStickerImage).toHaveBeenCalledTimes(abortAt === "before dispatch" ? 0 : 1);

        await vi.advanceTimersByTimeAsync(31_000);
        expect(setReaction.mock.calls).toEqual([["👀"]]);
      } finally {
        await controller.clear();
        vi.useRealTimers();
      }
    },
  );

  it("keeps Telegram typing below its client expiry without a per-message cutoff", async () => {
    await dispatchWithContext({ context: createContext() });

    expect(createChannelMessageReplyPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        typing: expect.objectContaining({
          keepaliveIntervalMs: 4_000,
          maxDurationMs: 0,
        }),
      }),
    );
  });

  it("cleans delivery correlation when reply-pipeline initialization fails", async () => {
    const sessionKey = "agent:main:telegram:direct:pipeline-init-failure";
    const statusReactionController = createStatusReactionController();
    const reactionApi = vi.fn(async () => undefined);
    const runtime = createRuntime();
    runtime.error = vi.fn(() => {
      telegramInboundEventDelivery.notify({
        sessionKey,
        to: "123",
        accountId: "default",
      });
    });
    createChannelMessageReplyPipeline.mockImplementationOnce(() => {
      throw new Error("pipeline initialization failed");
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          ChatType: "direct",
        } as TelegramMessageContext["ctxPayload"],
        statusReactionController: statusReactionController as never,
        reactionApi,
      }),
      runtime,
      suppressFailureFallback: true,
    });

    await vi.waitFor(() => {
      expect(statusReactionController.restoreInitial).toHaveBeenCalled();
    });
    expect(reactionApi).not.toHaveBeenCalled();
  });
});
