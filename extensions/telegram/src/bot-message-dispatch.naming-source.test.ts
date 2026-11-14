import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  generateTopicLabel,
  mockDefaultSessionEntry,
} from "./bot-message-dispatch.test-harness.js";
import {
  getTopicLabelMetadata,
  resolveTelegramDirectTopicNameCacheScope,
  updateTopicName,
} from "./topic-name-cache.js";

describeTelegramDispatch("Telegram reassessment source", () => {
  beforeEach(async () => {
    await captureRuntimeConfigAsyncReader()();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["separate", "buffered"] as const)(
    "keeps the opening task and six follow-ups (%s)",
    async (mode) => {
      const base = createContext();
      const sessionKey = base.ctxPayload.SessionKey!;
      const storePath = base.turn.storePath;
      const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
      const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
        "openclaw/plugin-sdk/session-store-runtime",
      );
      await sdk.prepareSessionEntryPatch({
        agentId: "default",
        storePath,
        sessionKey,
        fallbackEntry: { sessionId: "source-context", updatedAt: 1 },
        prepare: () => ({
          sessionId: "source-context",
          topicName: "Local voice loader",
          displayName: "Local voice loader",
        }),
        authority: { kind: "host", assertCurrent() {} },
        requireWriteSuccess: true,
      });
      mockDefaultSessionEntry({
        sessionId: "source-context",
        topicName: "Local voice loader",
        displayName: "Local voice loader",
        systemSent: true,
      });
      await updateTopicName(123, 777, { name: "Local voice loader" }, scope);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      });
      const bot = createBot();
      const edit = vi.spyOn(bot.api, "editForumTopic");
      const inputs = [
        "Repair the local voice loader and preserve its audio queue.",
        "Check speech detection before transcription.",
        "Keep short spoken phrases.",
        "Do not treat background noise as speech.",
        "Test a quiet clip.",
        "Continue the same repair.",
        "Continue.",
      ];
      generateTopicLabel.mockResolvedValue("Local voice loader");
      const batches =
        mode === "buffered" ? [[inputs[0]!], inputs.slice(1)] : inputs.map((input) => [input]);
      let messageIndex = 100;
      for (const batch of batches) {
        const buffered = batch.map((text) => ({
          ...base.msg,
          message_id: messageIndex++,
          text,
        }));
        const id = String(buffered.at(-1)!.message_id);
        const input = batch.join("\n");
        await dispatchWithContext({
          context: createContext({
            accountId: "default",
            ...(mode === "buffered" ? { bufferedMessages: buffered } : {}),
            ctxPayload: {
              ...base.ctxPayload,
              RawBody: input,
              ThreadLabel: "Local voice loader",
              MessageSid: id,
              ...(buffered.length > 1
                ? { MessageSids: buffered.map((message) => String(message.message_id)) }
                : {}),
            },
          }),
          bot,
          streamMode: "off",
        });
        await vi.waitFor(
          async () =>
            expect((await getTopicLabelMetadata(123, 777, scope))?.labelState?.lastMessageId).toBe(
              id,
            ),
          { timeout: 20_000 },
        );
      }
      await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledOnce(), {
        timeout: 20_000,
      });
      const source = generateTopicLabel.mock.calls[0]![0].userMessage;
      let offset = -1;
      for (const input of inputs) {
        const next = source.indexOf(input, offset + 1);
        expect(next, `missing ordered input: ${input}`).toBeGreaterThan(offset);
        offset = next;
      }
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState?.inputMessages).toEqual(
        inputs,
      );
      expect(edit).not.toHaveBeenCalled();
      if (mode === "buffered") {
        await dispatchWithContext({
          context: createContext({
            accountId: "default",
            bufferedMessages: inputs
              .slice(1)
              .map((text, index) => Object.assign({}, base.msg, { text, message_id: index + 101 })),
            ctxPayload: {
              ...base.ctxPayload,
              RawBody: inputs.slice(1).join("\n"),
              ThreadLabel: "Local voice loader",
              MessageSid: "106",
              MessageSids: ["101", "102", "103", "104", "105", "106"],
            },
          }),
          bot,
          streamMode: "off",
        });
        expect(generateTopicLabel).toHaveBeenCalledOnce();
      }
    },
  );
});
