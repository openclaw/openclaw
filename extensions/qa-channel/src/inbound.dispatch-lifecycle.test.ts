import { createReplyDispatcher, SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { getQaBusState, injectQaBusInboundMessage } from "./bus-client.js";
import { createQaInboundParams, runQaInbound } from "./inbound.test-harness.js";

async function withQaBus(run: (params: ReturnType<typeof createQaInboundParams>) => Promise<void>) {
  const bus = await startQaBusServer({ state: createQaBusState() });
  try {
    const params = createQaInboundParams();
    params.account.baseUrl = bus.baseUrl;
    params.config = { channels: { "qa-channel": { baseUrl: bus.baseUrl } } };
    params.message = (
      await injectQaBusInboundMessage({
        baseUrl: bus.baseUrl,
        input: params.message,
      })
    ).message;
    await run(params);
  } finally {
    await bus.stop();
  }
}

async function visibleReplies(baseUrl: string) {
  const state = await getQaBusState(baseUrl);
  return state.messages.filter((message) => message.direction === "outbound" && !message.deleted);
}

describe("QA inbound dispatch settlement", () => {
  it.each(["", SILENT_REPLY_TOKEN])(
    "removes the preview when dispatcher normalization suppresses final %j",
    async (text) => {
      await withQaBus(async (params) => {
        await runQaInbound(async (turn) => {
          const dispatcher = createReplyDispatcher({ ...turn.dispatcherOptions, ...turn.delivery });
          try {
            await turn.replyOptions?.onPartialReply?.({ text: "unfinished" });
            expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
              { text: "unfinished" },
            ]);
            expect(dispatcher.sendFinalReply({ text })).toBe(false);
            await turn.replyOptions?.onPartialReply?.({ text: "late partial" });
            expect(await visibleReplies(params.account.baseUrl)).toEqual([]);
          } finally {
            dispatcher.markComplete();
            await dispatcher.waitForIdle();
          }
        }, params);
        const state = await getQaBusState(params.account.baseUrl);
        expect(state.events.filter((event) => event.kind === "outbound-message")).toHaveLength(1);
        expect(state.events.filter((event) => event.kind === "message-deleted")).toHaveLength(1);
      });
    },
  );

  it("removes an unfinished preview before a zero-payload dispatch returns", async () => {
    await withQaBus(async (params) => {
      await runQaInbound(async (turn) => {
        await turn.replyOptions?.onPartialReply?.({ text: "unfinished" });
        expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
          { text: "unfinished" },
        ]);
      }, params);
      expect(await visibleReplies(params.account.baseUrl)).toEqual([]);
    });
  });

  it("keeps preview updates after an empty nonterminal block and preserves the final", async () => {
    await withQaBus(async (params) => {
      await runQaInbound(async (turn) => {
        const dispatcher = createReplyDispatcher({ ...turn.dispatcherOptions, ...turn.delivery });
        try {
          await turn.replyOptions?.onPartialReply?.({ text: "draft" });
          expect(dispatcher.sendBlockReply({ text: "" })).toBe(false);
          await turn.replyOptions?.onPartialReply?.({ text: "expanded draft" });
          expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
            { text: "expanded draft" },
          ]);
          expect(dispatcher.sendFinalReply({ text: "answer" })).toBe(true);
        } finally {
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
        }
      }, params);
      expect(await visibleReplies(params.account.baseUrl)).toMatchObject([{ text: "answer" }]);
      const state = await getQaBusState(params.account.baseUrl);
      expect(state.events.filter((event) => event.kind === "outbound-message")).toHaveLength(1);
      expect(state.events.filter((event) => event.kind === "message-deleted")).toHaveLength(0);
    });
  });
});
