// Documents the deliverer-level rotation contract for consecutive outbound text
// parts, driving the REAL createTelegramDraftStream + REAL createLaneTextDeliverer
// (no mocked stream) against a fake grammY api and counting sendRichMessage (new
// message) vs editMessageText (edit-in-place):
//   - consecutive FINAL parts rotate into separate messages (rotateFinalizedStream),
//   - consecutive BLOCK parts coalesce into one edited message; block rotation is
//     owned by bot-message-dispatch, not the deliverer.
// The end-to-end split for distinct messages / tool boundaries is covered in
// bot-message-dispatch.test.ts ("consecutive block messages (real draft stream)").
import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";
import { createLaneTextDeliverer, type DraftLaneState, type LaneName } from "./lane-delivery.js";

function createReproHarness() {
  let nextMessageId = 100;
  const sendRichMessage = vi.fn(async () => ({ message_id: nextMessageId++ }));
  const editMessageText = vi.fn(async () => true);
  const deleteMessage = vi.fn(async () => true);
  const api = {
    raw: { sendRichMessage, editMessageText },
    deleteMessage,
  } as unknown as Bot["api"];

  const makeLane = (): DraftLaneState => ({
    stream: createTelegramDraftStream({ api, chatId: 123 }),
    lastPartialText: "",
    hasStreamedMessage: false,
    finalized: false,
    activeChunkIndex: 0,
  });
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: makeLane(),
    reasoning: makeLane(),
  };

  const deliverLaneText = createLaneTextDeliverer({
    lanes,
    draftMaxChars: 4096,
    applyTextToPayload: (payload, text) => ({ ...payload, text }),
    sendPayload: vi.fn(async () => true),
    flushDraftLane: async (lane) => {
      await lane.stream?.flush();
    },
    stopDraftLane: async (lane) => {
      await lane.stream?.stop();
    },
    clearDraftLane: async (lane) => {
      await lane.stream?.clear();
    },
    editStreamMessage: vi.fn(async () => {}),
    log: vi.fn(),
    markDelivered: vi.fn(),
  });

  return { deliverLaneText, sendRichMessage, editMessageText };
}

describe("consecutive outbound text parts (real stream + deliverer)", () => {
  it("sends two separate messages for two consecutive FINAL parts", async () => {
    const { deliverLaneText, sendRichMessage, editMessageText } = createReproHarness();

    await deliverLaneText({
      laneName: "answer",
      text: "Message A",
      payload: { text: "Message A" },
      infoKind: "final",
    });
    await deliverLaneText({
      laneName: "answer",
      text: "Message B",
      payload: { text: "Message B" },
      infoKind: "final",
    });

    expect({
      sends: sendRichMessage.mock.calls.length,
      edits: editMessageText.mock.calls.length,
    }).toEqual({ sends: 2, edits: 0 });
  });

  // The deliverer does NOT rotate consecutive blocks itself — block rotation is
  // owned one layer up (bot-message-dispatch: assistantMessageIndex changes,
  // onAssistantMessageStart, and the onToolStart tool-boundary rotation). At the
  // deliverer level two consecutive blocks correctly coalesce into one edited
  // message; the dispatch decides when to start a new one.
  it("coalesces two consecutive BLOCK parts into one edited message (rotation owned by dispatch)", async () => {
    const { deliverLaneText, sendRichMessage, editMessageText } = createReproHarness();

    await deliverLaneText({
      laneName: "answer",
      text: "Message A",
      payload: { text: "Message A" },
      infoKind: "block",
    });
    await deliverLaneText({
      laneName: "answer",
      text: "Message B",
      payload: { text: "Message B" },
      infoKind: "block",
    });

    expect({
      sends: sendRichMessage.mock.calls.length,
      edits: editMessageText.mock.calls.length,
    }).toEqual({ sends: 1, edits: 1 });
  });
});
