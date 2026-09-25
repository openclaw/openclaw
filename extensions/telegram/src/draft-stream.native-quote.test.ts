import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  createDraftStream,
  createMockDraftApi,
  type MockSentMessage,
} from "./draft-stream.api.test-helpers.js";
import { buildTelegramRichMarkdown } from "./rich-message.js";

const replyQuote = {
  text: "Original request",
  position: 0,
  entities: [{ type: "bold", offset: 0, length: 8 }],
};

describe("Telegram preview native quotes", () => {
  it.each([false, true].flatMap((rich) => [false, true].map((rejected) => ({ rich, rejected }))))(
    "retains the accepted preview (rich: $rich, quote rejected: $rejected)",
    async ({ rich, rejected }) => {
      const api = createMockDraftApi();
      const send = rich ? api.raw.sendRichMessage : api.sendMessage;
      if (rejected) {
        send.mockRejectedValueOnce(new Error("Bad Request: quote not found"));
      }
      const stream = createDraftStream(api, {
        thread: { id: 99, scope: "forum" },
        replyToMessageId: 7,
        replyToMode: "all",
        replyQuote,
        richMessages: rich,
        renderText: (text) =>
          rich
            ? { text, richMessage: buildTelegramRichMarkdown(text) }
            : { text, parseMode: "HTML" },
      });
      try {
        stream.update("First");
        await stream.flush();
        stream.update("Final");
        await stream.stop();
        const requests = rich
          ? api.raw.sendRichMessage.mock.calls.map(([params]) => params)
          : api.sendMessage.mock.calls.map((call) => call[2]);
        expect(requests).toHaveLength(rejected ? 2 : 1);
        expect(requests[0]).toMatchObject({
          message_thread_id: 99,
          reply_parameters: {
            message_id: 7,
            allow_sending_without_reply: true,
            quote: replyQuote.text,
            quote_position: 0,
            quote_entities: replyQuote.entities,
          },
        });
        if (rejected) {
          expect(requests[1]).toMatchObject(
            rich
              ? {
                  message_thread_id: 99,
                  reply_parameters: { message_id: 7, allow_sending_without_reply: true },
                }
              : {
                  message_thread_id: 99,
                  reply_to_message_id: 7,
                  allow_sending_without_reply: true,
                },
          );
          expect(requests[1]).not.toHaveProperty("reply_parameters.quote");
        }
        if (rich) {
          expect(api.raw.editMessageText).toHaveBeenCalledWith(
            expect.objectContaining({ chat_id: 123, message_id: 17 }),
          );
          expect(api.sendMessage).not.toHaveBeenCalled();
        } else {
          expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "Final", {
            parse_mode: "HTML",
          });
        }
        expect(stream.currentMessageSnapshot()).toMatchObject({
          text: "Final",
          replyToMessageId: 7,
        });
        expect(api.deleteMessage).not.toHaveBeenCalled();
      } finally {
        await stream.discard();
      }
    },
  );

  it.each(
    ["quote", "format"].flatMap((failure) =>
      ["authorization", "generation", "discard"].map((retirement) => ({ failure, retirement })),
    ),
  )(
    "does not retry $failure after $retirement retires the send",
    async ({ failure, retirement }) => {
      const pending = createDeferred<MockSentMessage>();
      void pending.promise.catch(() => undefined);
      const api = createMockDraftApi();
      api.raw.sendRichMessage.mockImplementationOnce(() => pending.promise);
      let authorized = true;
      const stream = createDraftStream(api, {
        replyToMessageId: 7,
        replyToMode: "all",
        replyQuote,
        richMessages: true,
        renderText: (text) => ({ text, richMessage: buildTelegramRichMarkdown(text) }),
        warn: vi.fn(),
      });
      let discarding: Promise<void> | undefined;
      const rejection = new Error(
        failure === "quote"
          ? "Bad Request: quote not found"
          : "Bad Request: RICH_MESSAGE_ENTITIES_INVALID",
      );
      try {
        stream.update("Retired answer", {
          assertPlatformSendAuthorized: () => {
            if (!authorized) {
              throw new Error("Send authority revoked");
            }
          },
        });
        await vi.waitFor(() => expect(api.raw.sendRichMessage).toHaveBeenCalledOnce());
        if (retirement === "authorization") {
          authorized = false;
        } else if (retirement === "generation") {
          stream.forceNewMessage();
        } else {
          discarding = stream.discard();
        }
        pending.reject(rejection);
        await stream.waitForInFlight();
        await discarding;
        expect(api.raw.sendRichMessage).toHaveBeenCalledOnce();
        expect(api.sendMessage).not.toHaveBeenCalled();
        if (retirement === "generation") {
          stream.update("Replacement");
          await stream.stop();
          expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
          expect(stream.currentMessageSnapshot()).toMatchObject({ text: "Replacement" });
        }
      } finally {
        pending.reject(rejection);
        await stream.discard();
        await discarding;
      }
    },
  );
});
