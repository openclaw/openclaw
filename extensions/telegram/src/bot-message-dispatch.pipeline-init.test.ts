import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  createContext,
  dispatchReplyWithBufferedBlockDispatcher,
  describeTelegramDispatch,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";

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
});
