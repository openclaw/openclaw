import type { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi, type Mock } from "vitest";
import {
  createInboundMessage,
  DEFAULT_SENDER,
  type MonitorRunParams,
  type WatchClientParams,
} from "./monitor.last-route.test-support.js";
import { rememberPersistedIMessageEcho } from "./monitor/persisted-echo-cache.js";

export function defineIMessageSelfChatLoopBudgetTests(fixtures: {
  runMessageCase: (params: WatchClientParams & { monitor?: MonitorRunParams }) => Promise<unknown>;
  dispatchReplyWithBufferedBlockDispatcherMock: Mock<
    typeof dispatchReplyWithBufferedBlockDispatcher
  >;
}) {
  const { runMessageCase, dispatchReplyWithBufferedBlockDispatcherMock } = fixtures;
  it("delivers eight self-chat turns without counting their paired rows as echo loops", async () => {
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const texts = Array.from({ length: 8 }, (_, index) => `self-chat message ${index + 1}`);
    const createdAt = new Date().toISOString();
    await runMessageCase({
      messages: texts.flatMap((text, index) =>
        [true, false].map((isFromMe) =>
          createInboundMessage({
            id: index * 2 + (isFromMe ? 1 : 2),
            guid: `self-chat-${index}-${isFromMe}`,
            text,
            chat_identifier: DEFAULT_SENDER,
            is_from_me: isFromMe,
            created_at: createdAt,
            destination_caller_id: DEFAULT_SENDER,
          }),
        ),
      ),
      monitor: { runtime },
    });
    expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(texts.length);
    expect(
      dispatchReplyWithBufferedBlockDispatcherMock.mock.calls.map(
        ([params]) => params.ctx.BodyForAgent,
      ),
    ).toEqual(texts);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(
      runtime.log.mock.calls.some(([message]) => String(message).includes("rate limiter tripped")),
    ).toBe(false);
  });

  it("keeps verified self-chat reply reflections out of the loop budget", async () => {
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const outboundGuid = "p:0/outbound-parent-guid";
    const reflectedText = "reflected reply";
    const legitimateText = "legitimate self-chat follow-up";
    await rememberPersistedIMessageEcho({
      scope: `default:imessage:${DEFAULT_SENDER}`,
      text: reflectedText,
      messageId: outboundGuid,
    });

    await runMessageCase({
      messages: [
        ...Array.from({ length: 5 }, (_, index) =>
          createInboundMessage({
            id: index + 1,
            guid: `p:0/reflected-row-${index + 1}`,
            reply_to_guid: outboundGuid,
            text: reflectedText,
            chat_identifier: DEFAULT_SENDER,
            is_from_me: false,
            destination_caller_id: DEFAULT_SENDER,
          }),
        ),
        createInboundMessage({
          id: 6,
          guid: "p:0/legitimate-user-row",
          text: legitimateText,
          chat_identifier: DEFAULT_SENDER,
          is_from_me: true,
          destination_caller_id: DEFAULT_SENDER,
        }),
      ],
      afterNotify: async () => {
        // Each strict reflection costs a persisted-cache read, so the six-row batch that proves
        // the loop budget survived can land well past the default wait window on slower hosts.
        await vi.waitFor(
          () => {
            expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
          },
          { timeout: 15_000 },
        );
      },
      monitor: { runtime },
    });

    expect(dispatchReplyWithBufferedBlockDispatcherMock.mock.calls[0]?.[0].ctx.BodyForAgent).toBe(
      legitimateText,
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(
      runtime.log.mock.calls.some(([message]) => String(message).includes("rate limiter tripped")),
    ).toBe(false);
  });
}
