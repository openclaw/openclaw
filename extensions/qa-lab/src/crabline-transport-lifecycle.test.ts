import {
  startOpenClawCrablineAdapter,
  type StartOpenClawCrablineAdapterParams,
} from "@openclaw/crabline";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { telegramApi } from "./crabline-transport.test-support.js";
import { createQaTransportAdapter } from "./qa-transport-registry.js";
import type { QaTransportAdapter, QaTransportOutboundSequenceMatch } from "./qa-transport.js";

vi.mock("@openclaw/crabline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/crabline")>();
  return {
    ...actual,
    // Capture the public observer while preserving the real server, arguments, and events.
    startOpenClawCrablineAdapter: vi.fn(actual.startOpenClawCrablineAdapter),
  };
});

afterEach(vi.clearAllMocks);

const CHAT_ID = "-1001234567890";
const THREAD_ID = "42";
const REJECTED_MARKER = "rejected lifecycle marker";
// Crabline's Telegram text limit is 4096 UTF-16 code units without a parse mode.
const REJECTED_TEXT = `${REJECTED_MARKER}${"x".repeat(4097)}`;
const FINAL_TEXT = "accepted final marker";

type Observer = NonNullable<StartOpenClawCrablineAdapterParams["onEvent"]>;
type Sequence = Awaited<ReturnType<NonNullable<QaTransportAdapter["waitForOutboundSequence"]>>>;
type TelegramFixture = {
  transport: QaTransportAdapter;
  observe: Observer;
  post: ReturnType<typeof telegramApi>["post"];
  send: (text: string) => Promise<number>;
  wait: (input?: Partial<QaTransportOutboundSequenceMatch>) => Promise<Sequence>;
};

async function withTelegramTransport(run: (fixture: TelegramFixture) => Promise<void>) {
  await withTempDir("qa-crabline-lifecycle-", async (outputDir) => {
    const created = await createQaTransportAdapter({
      channelId: "telegram",
      driver: "crabline",
      outputDir,
      state: createQaBusState(),
    });
    const transport = created.adapter;
    try {
      const observe = vi.mocked(startOpenClawCrablineAdapter).mock.calls.at(-1)?.[0].onEvent;
      const api = telegramApi(transport);
      if (!observe || !transport.waitForOutboundSequence) {
        throw new Error("Crabline Telegram lifecycle fixture is incomplete");
      }
      await transport.sendInbound({
        conversation: { id: CHAT_ID, kind: "group" },
        senderId: "100001",
        text: "forum topic seed",
        threadId: THREAD_ID,
      });
      const waitForSequence = transport.waitForOutboundSequence;
      await run({
        transport,
        observe,
        post: (method, body, status) => api.post(method, { chat_id: CHAT_ID, ...body }, status),
        send: (text) => api.send(CHAT_ID, THREAD_ID, text),
        wait: (input = {}) =>
          waitForSequence({
            conversationId: CHAT_ID,
            finalSettleMs: 0,
            finalTextIncludes: FINAL_TEXT,
            minimumPreviewEvents: 1,
            threadId: THREAD_ID,
            timeoutMs: 25,
            ...input,
          }),
      });
    } finally {
      await created.cleanupAfterGatewayStop();
    }
  });
}

function expectAcceptedSequence(sequence: Sequence, messageId: number) {
  const id = String(messageId);
  expect(
    sequence.events.map(({ cursor, kind, message: { id: eventId, threadId } }) => [
      cursor,
      kind,
      eventId,
      threadId,
    ]),
  ).toEqual([
    [1, "sent", id, THREAD_ID],
    [2, "edited", id, THREAD_ID],
  ]);
  expect(sequence.final).toMatchObject({ id, text: FINAL_TEXT, threadId: THREAD_ID });
  expect(sequence.events.some(({ message }) => message.text.includes(REJECTED_MARKER))).toBe(false);
}

describe("Crabline Telegram accepted lifecycle", () => {
  it.each(["sendMessage", "editMessageText"] as const)(
    "does not deliver a rejected %s final and preserves accepted recovery",
    async (method) => {
      await withTelegramTransport(async ({ transport, post, send, wait }) => {
        const messageId = await send("accepted preview");
        await post(
          method,
          {
            ...(method === "editMessageText"
              ? { message_id: messageId + 1000 }
              : { message_thread_id: Number(THREAD_ID) }),
            text: REJECTED_TEXT,
          },
          400,
        );

        await expect(wait({ finalTextIncludes: REJECTED_MARKER })).rejects.toThrow(
          "timed out after 25ms",
        );
        expect(transport.state.searchMessages({ query: REJECTED_MARKER })).toEqual([]);
        // The rejected candidate must not consume the pending send or steal its topic.
        await post("editMessageText", { message_id: messageId, text: FINAL_TEXT });
        expectAcceptedSequence(await wait(), messageId);
      });
    },
  );

  it("ignores delete observations unless acceptance is true", async () => {
    await withTelegramTransport(async ({ transport, observe, post, send, wait }) => {
      // Inject observer events: the provider's delete API always succeeds.
      for (const acceptance of [{}, { accepted: false }, { accepted: "true" }]) {
        await transport.reset();
        const messageId = await send("accepted preview");
        const event: Parameters<Observer>[0] & { accepted?: unknown } = {
          at: "2026-01-01T00:00:00.000Z",
          body: { chat_id: CHAT_ID, message_id: messageId + 1000 },
          method: "POST",
          path: "/bot<redacted>/deleteMessage",
          query: {},
          type: "api",
          ...acceptance,
        };
        await observe(event);
        await post("editMessageText", { message_id: messageId, text: FINAL_TEXT });

        expectAcceptedSequence(await wait(), messageId);
      }
    });
  });

  it("honors accepted deletes and clears pending IDs, bound IDs, and cursors on reset", async () => {
    await withTelegramTransport(async ({ transport, post, send, wait }) => {
      const messageId = await send("accepted preview");
      expect(transport.state.searchMessages({ query: "accepted preview" })).toEqual([
        expect.objectContaining({ text: "accepted preview" }),
      ]);
      await post("editMessageText", { message_id: messageId, text: FINAL_TEXT });
      expectAcceptedSequence(await wait(), messageId);

      await expect(post("deleteMessage", { message_id: messageId })).resolves.toMatchObject({
        ok: true,
        result: true,
      });
      await expect(wait()).rejects.toThrow("timed out after 25ms");

      const replacementId = await send("replacement preview");
      await post("editMessageText", { message_id: replacementId, text: FINAL_TEXT });
      const replacement = await wait({ sinceCursor: 3 });
      expect(
        replacement.events.map(({ cursor, kind, message }) => [cursor, kind, message.id]),
      ).toEqual([
        [4, "sent", String(replacementId)],
        [5, "edited", String(replacementId)],
      ]);
      expect(replacement.final.threadId).toBe(THREAD_ID);

      // Leave both bound and pending provider identities behind before resetting.
      await send("pending preview before reset");
      await transport.reset();
      expect(transport.state.getSnapshot().messages).toEqual([]);
      await expect(wait()).rejects.toThrow("timed out after 25ms");
      await post("editMessageText", { message_id: replacementId, text: FINAL_TEXT });
      await expect(wait({ minimumPreviewEvents: 0 })).rejects.toThrow("timed out after 25ms");
      const afterReset = await wait({ minimumPreviewEvents: 0, threadId: undefined });
      expect(
        afterReset.events.map(({ cursor, kind, message }) => [cursor, kind, message.id]),
      ).toEqual([[1, "edited", String(replacementId)]]);
      expect(afterReset.final.threadId).toBeUndefined();
    });
  });
});
