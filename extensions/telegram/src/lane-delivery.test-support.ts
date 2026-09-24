import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { expect, vi } from "vitest";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import {
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
} from "./lane-delivery-text-deliverer.js";
import {
  createTelegramPromptContextProjectionSequence,
  type TelegramPromptContextProjectionSequence,
} from "./prompt-context-projection.js";

type PromptContextRecord = Parameters<
  typeof createTelegramPromptContextProjectionSequence
>[0]["record"];

export function createHarness(params?: {
  answerMessageId?: number;
  answerStream?: DraftLaneState["stream"] | null;
}) {
  const answer =
    params?.answerStream === null
      ? undefined
      : (params?.answerStream ?? createTestDraftStream({ messageId: params?.answerMessageId }));
  const reasoning = createTestDraftStream();
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: {
      stream: answer,
      lastPartialText: "",
      hasStreamedMessage: false,
      finalized: false,
      retainedPromptContextPages: [],
    },
    reasoning: {
      stream: reasoning,
      lastPartialText: "",
      hasStreamedMessage: false,
      finalized: false,
      retainedPromptContextPages: [],
    },
  };
  const sendPayload = vi
    .fn<Parameters<typeof createLaneTextDeliverer>[0]["sendPayload"]>()
    .mockResolvedValue({ visibleReplySent: true });
  const flushDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    await lane.stream?.flush();
  });
  const stopDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    await lane.stream?.stop();
  });
  const clearDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    await lane.stream?.clear();
  });
  const editStreamMessage = vi.fn().mockResolvedValue(undefined);
  const recordPromptContextPreview = vi.fn<PromptContextRecord>().mockResolvedValue(true);
  const createPromptContextSequence = () =>
    createTelegramPromptContextProjectionSequence({ record: recordPromptContextPreview });
  const markDelivered = vi.fn();

  const deliverLaneText = createLaneTextDeliverer({
    lanes,
    applyTextToPayload: (payload: ReplyPayload, text: string) => ({ ...payload, text }),
    sendPayload,
    flushDraftLane,
    stopDraftLane,
    clearDraftLane,
    editStreamMessage,
    createPromptContextSequence,
    log: () => {},
    markDelivered,
  });

  return {
    deliverLaneText,
    lanes,
    answer,
    reasoning,
    sendPayload,
    flushDraftLane,
    stopDraftLane,
    clearDraftLane,
    editStreamMessage,
    recordPromptContextPreview,
    markDelivered,
  };
}

export async function deliverFinalAnswer(harness: ReturnType<typeof createHarness>, text: string) {
  return harness.deliverLaneText({
    laneName: "answer",
    text,
    payload: { text },
    infoKind: "final",
  });
}

function createProjectionSequence(
  record: PromptContextRecord,
): TelegramPromptContextProjectionSequence {
  return createTelegramPromptContextProjectionSequence({
    source: { transcriptMessageId: "assistant-1" },
    record,
  });
}

export async function deliverProjectedFinalAnswer(
  harness: ReturnType<typeof createHarness>,
  text: string,
) {
  return harness.deliverLaneText({
    laneName: "answer",
    text,
    payload: { text },
    infoKind: "final",
    promptContextSequence: createProjectionSequence(harness.recordPromptContextPreview),
  });
}

export function expectPreviewFinalized(
  result: LaneDeliveryResult,
): Extract<LaneDeliveryResult, { kind: "preview-finalized" }>["delivery"] {
  expect(result.kind).toBe("preview-finalized");
  if (result.kind !== "preview-finalized") {
    throw new Error(`expected preview-finalized, got ${result.kind}`);
  }
  return result.delivery;
}

export function expectRecordedPreview(
  recordPromptContextPreview: ReturnType<typeof vi.fn>,
  index: number,
  params: { messageId?: number; text: string; partIndex: number; finalPart: boolean },
) {
  expect(recordPromptContextPreview.mock.calls[index]?.[0]).toEqual({
    messageId: params.messageId ?? 999,
    text: params.text,
    projection: {
      transcriptMessageId: "assistant-1",
      partIndex: params.partIndex,
      finalPart: params.finalPart,
    },
  });
}

export function expectSentPayload(
  harness: ReturnType<typeof createHarness>,
  payload: ReplyPayload,
  durable: boolean,
) {
  expect(harness.sendPayload).toHaveBeenCalledWith(
    payload,
    expect.objectContaining({
      durable,
      promptContextSequence: expect.any(Object),
    }),
  );
}
