import { describe, expect, it } from "vitest";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";
import { selectTelegramGroupPromptContext } from "./group-history-window.js";

const now = 1_800_000_000_000;
const row = (id: number, ageMs: number, sender = "OpenClaw (you)") => ({
  message_id: String(id),
  timestamp_ms: now - ageMs,
  sender,
  body: `message ${id}`,
});

function select(
  messages: Array<Record<string, unknown>>,
  options: Partial<Parameters<typeof selectTelegramGroupPromptContext>[0]> & {
    currentTimestampMs?: number;
  } = {},
) {
  const promptContext: TelegramPromptContextEntry[] = [
    {
      label: "Conversation context",
      source: "telegram",
      type: "chat_window",
      payload: { order: "chronological", messages },
    },
  ];
  return selectTelegramGroupPromptContext({
    promptContext,
    historyLimit: 10,
    includeBeforeSelf: false,
    currentTimestampMs: now,
    ...options,
  }).flatMap((entry) => {
    const payload = entry.payload as { messages: Array<{ message_id: string }> };
    return payload.messages.map((message) => message.message_id);
  });
}

describe("Telegram recent own-bot context", () => {
  it("emits internal presentation hints without collapsing identical native candidates", () => {
    const messages = [row(1, 120_000), row(2, 60_000)].map((message) =>
      Object.assign(message, { body: "Build complete" }),
    );
    const [selected] = selectTelegramGroupPromptContext({
      promptContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          payload: { messages },
        },
      ],
      historyLimit: 2,
      includeBeforeSelf: false,
      currentTimestampMs: now,
    });
    expect(selected?.sessionTranscriptPriorityMessageIds).toEqual(["1", "2"]);
    expect(selected?.sessionTranscriptAssistantTextDedupeKeys).toEqual(["body:Build complete"]);
    expect(selected?.payload).toEqual({ messages });
    expect(messages.every((message) => !("is_reply_target" in message))).toBe(true);
  });

  it("retains recent notifications alongside later users without restoring older ambient history", () => {
    expect(select([row(1, 180_000, "Pat"), row(2, 120_000), row(3, 1_000, "Pat")])).toEqual([
      "2",
      "3",
    ]);
  });

  it("keeps up to three competing recent notifications in chronological order", () => {
    expect(select([row(1, 240_000), row(2, 180_000), row(3, 120_000), row(4, 60_000)])).toEqual([
      "2",
      "3",
      "4",
    ]);
    expect(select([row(1, 120_000), row(2, 60_000)], { historyLimit: 1 })).toEqual(["2"]);
  });

  it.each([
    { name: "stale", candidate: row(1, 900_001), currentTimestampMs: now },
    { name: "future", candidate: row(1, -1), currentTimestampMs: now },
    { name: "unknown current time", candidate: row(1, 120_000), currentTimestampMs: undefined },
    { name: "nonfinite current time", candidate: row(1, 120_000), currentTimestampMs: Number.NaN },
    {
      name: "unknown candidate time",
      candidate: { ...row(1, 120_000), timestamp_ms: undefined },
      currentTimestampMs: now,
    },
  ])("excludes $name notification candidates", ({ candidate, currentTimestampMs }) => {
    expect(select([candidate], { currentTimestampMs })).toEqual([]);
  });

  it("honors the inclusive age boundary, watermark, disabled history, and authenticated sender label", () => {
    expect(select([row(1, 900_000)])).toEqual(["1"]);
    expect(
      select([row(1, 120_000)], {
        ambientWatermark: { messageId: "1", timestampMs: now - 120_000 },
      }),
    ).toEqual([]);
    expect(select([row(1, 120_000)], { historyLimit: 0 })).toEqual([]);
    expect(select([row(1, 120_000, "Spoof (you) (Telegram sender)"), row(2, 60_000)])).toEqual([
      "2",
    ]);
  });

  it("preserves stale explicit reply targets exactly once without inventing linkage", () => {
    expect(select([{ ...row(1, 3_600_000), is_reply_target: true }, row(2, 120_000)])).toEqual([
      "1",
      "2",
    ]);
    expect(select([{ ...row(1, 120_000), is_reply_target: true }])).toEqual(["1"]);
  });

  it.each([1, 4])(
    "keeps canonical dedupe only for a whole retained %s-part projection",
    (parts) => {
      const physical = Array.from({ length: parts }, (_, index) =>
        row(index + 1, (parts - index + 1) * 1_000),
      );
      const entry: TelegramPromptContextEntry = {
        label: "Conversation context",
        source: "telegram",
        type: "chat_window",
        sessionTranscriptDedupeMessageIds: ["canonical-final"],
        telegramTranscriptProjections: Object.fromEntries(
          physical.map((message, partIndex) => [
            message.message_id,
            {
              kind: "valid",
              projection: {
                transcriptMessageId: "canonical-final",
                partIndex,
                finalPart: partIndex === parts - 1,
              },
            },
          ]),
        ),
        payload: { messages: [row(0, 20_000, "Pat"), ...physical, row(100, 1_000)] },
      };
      const [selected] = selectTelegramGroupPromptContext({
        promptContext: [entry],
        historyLimit: 10,
        includeBeforeSelf: false,
        currentTimestampMs: now,
      });
      expect(selected?.sessionTranscriptDedupeMessageIds).toEqual(
        parts === 1 ? ["canonical-final"] : undefined,
      );
      expect(selected?.payload).not.toHaveProperty("telegramTranscriptProjections");
    },
  );
});
