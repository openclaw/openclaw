import {
  startOpenClawCrablineAdapter,
  type StartOpenClawCrablineAdapterParams,
} from "@openclaw/crabline";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapterFactory } from "./crabline-transport-factory.js";
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

afterEach(() => {
  vi.clearAllMocks();
});

const CHAT_ID = "-1001234567890";
const THREAD_ID = "42";
const REJECTED_MARKER = "rejected lifecycle marker";
// Crabline's Telegram text limit is 4096 UTF-16 code units without a parse mode.
const REJECTED_TEXT = `${REJECTED_MARKER}${"x".repeat(4097)}`;
const FINAL_TEXT = "accepted final marker";

type TelegramMethod = "sendMessage" | "editMessageText" | "deleteMessage";
type Observer = NonNullable<StartOpenClawCrablineAdapterParams["onEvent"]>;
type Transport = QaTransportAdapter;
type Sequence = Awaited<ReturnType<NonNullable<Transport["waitForOutboundSequence"]>>>;
type TelegramFixture = {
  transport: Transport;
  observe: Observer;
  post: (
    method: TelegramMethod,
    body: Record<string, unknown>,
    status?: number,
  ) => Promise<unknown>;
  send: (text: string) => Promise<number>;
  wait: (input?: Partial<QaTransportOutboundSequenceMatch>) => Promise<Sequence>;
};

async function withTelegramTransport(run: (fixture: TelegramFixture) => Promise<void>) {
  await withTempDir("qa-crabline-lifecycle-", async (outputDir) => {
    const state = createQaBusState();
    const created = await createQaTransportAdapter(
      {
        channelId: "telegram",
        driver: "crabline",
        outputDir,
        state,
      },
      [createQaCrablineTransportAdapterFactory(state)],
    );
    const transport = created.adapter;
    try {
      const observe = vi.mocked(startOpenClawCrablineAdapter).mock.calls.at(-1)?.[0].onEvent;
      const telegram = transport.createGatewayConfig({
        baseUrl: "http://127.0.0.1:1",
      }).channels?.telegram;
      if (
        !observe ||
        !transport.waitForOutboundSequence ||
        typeof telegram?.apiRoot !== "string" ||
        typeof telegram.botToken !== "string"
      ) {
        throw new Error("Crabline Telegram lifecycle fixture is incomplete");
      }
      const { apiRoot, botToken } = telegram;
      await transport.sendInbound({
        conversation: { id: CHAT_ID, kind: "group" },
        senderId: "100001",
        text: "forum topic seed",
        threadId: THREAD_ID,
      });
      const post: TelegramFixture["post"] = async (method, body, status = 200) => {
        const response = await fetch(`${apiRoot}/bot${botToken}/${method}`, {
          body: JSON.stringify({ chat_id: CHAT_ID, ...body }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const payload: unknown = await response.json();
        expect(response.status).toBe(status);
        expect(payload).toMatchObject({ ok: status === 200 });
        return payload;
      };
      const send: TelegramFixture["send"] = async (text) => {
        const payload = await post("sendMessage", {
          message_thread_id: Number(THREAD_ID),
          text,
        });
        if (
          !isRecord(payload) ||
          !isRecord(payload.result) ||
          typeof payload.result.message_id !== "number"
        ) {
          throw new Error("Crabline Telegram send did not return a message ID");
        }
        return payload.result.message_id;
      };
      const waitForSequence = transport.waitForOutboundSequence;
      await run({
        transport,
        observe,
        post,
        send,
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
  expect(
    sequence.events.map(({ cursor, kind, message }) => ({
      cursor,
      kind,
      id: message.id,
      threadId: message.threadId,
    })),
  ).toEqual([
    { cursor: 1, kind: "sent", id: String(messageId), threadId: THREAD_ID },
    { cursor: 2, kind: "edited", id: String(messageId), threadId: THREAD_ID },
  ]);
  expect(sequence.final).toMatchObject({
    id: String(messageId),
    text: FINAL_TEXT,
    threadId: THREAD_ID,
  });
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

  it.each(["sendMessage", "editMessageText"] as const)(
    "does not count a rejected %s as preview evidence",
    async (method) => {
      await withTelegramTransport(async ({ post, send, wait }) => {
        const existingId = method === "editMessageText" ? await send(FINAL_TEXT) : undefined;
        await post(
          method,
          {
            ...(existingId === undefined
              ? { message_thread_id: Number(THREAD_ID) }
              : { message_id: existingId + 1000 }),
            text: REJECTED_TEXT,
          },
          400,
        );
        const messageId = existingId ?? (await send(FINAL_TEXT));
        await post("editMessageText", { message_id: messageId, text: FINAL_TEXT });

        // With only accepted final text, there is no qualifying preview.
        await expect(wait()).rejects.toThrow("timed out after 25ms");
        expectAcceptedSequence(await wait({ minimumPreviewEvents: 0 }), messageId);
      });
    },
  );

  it.each(["sendMessage", "editMessageText", "deleteMessage"] as const)(
    "ignores synthetic %s observations unless acceptance is true",
    async (method) => {
      await withTelegramTransport(async ({ transport, observe, post, send, wait }) => {
        // These exercise the observer contract, not provider failures: authenticated
        // deleteMessage is a success stub, and real recorder events carry a boolean.
        for (const acceptance of [{}, { accepted: false }, { accepted: "true" }]) {
          await transport.reset();
          const messageId = await send("accepted preview");
          const event: Parameters<Observer>[0] & { accepted?: unknown } = {
            at: "2026-01-01T00:00:00.000Z",
            body: {
              chat_id: CHAT_ID,
              ...(method === "sendMessage"
                ? { message_thread_id: Number(THREAD_ID) }
                : { message_id: messageId + 1000 }),
              ...(method === "deleteMessage" ? {} : { text: REJECTED_MARKER }),
            },
            method: "POST",
            path: `/bot<redacted>/${method}`,
            query: {},
            type: "api",
            ...acceptance,
          };
          await observe(event);
          await post("editMessageText", { message_id: messageId, text: FINAL_TEXT });

          expectAcceptedSequence(await wait(), messageId);
          expect(transport.state.searchMessages({ query: REJECTED_MARKER })).toEqual([]);
        }
      });
    },
  );

  it("honors accepted deletes and clears pending IDs, bound IDs, and cursors on reset", async () => {
    await withTelegramTransport(async ({ transport, post, send, wait }) => {
      const messageId = await send("accepted preview");
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
