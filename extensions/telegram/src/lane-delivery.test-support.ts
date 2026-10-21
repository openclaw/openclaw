import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { expect, vi } from "vitest";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import {
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
} from "./lane-delivery-text-deliverer.js";
import { createTelegramPromptContextProjectionSequence } from "./prompt-context-projection.js";

type PromptContextRecord = Parameters<
  typeof createTelegramPromptContextProjectionSequence
>[0]["record"];
type DelivererOptions = Parameters<typeof createLaneTextDeliverer>[0];

function lane(stream: DraftLaneState["stream"]): DraftLaneState {
  return {
    stream,
    lastPartialText: "",
    hasStreamedMessage: false,
    finalized: false,
    retainedPromptContextPages: [],
  };
}

export function createHarness(params?: {
  answerMessageId?: number;
  answerStream?: DraftLaneState["stream"] | null;
  resolveFinalPayloadCandidate?: DelivererOptions["resolveFinalPayloadCandidate"];
  resolveFinalPresentationText?: DelivererOptions["resolveFinalPresentationText"];
}) {
  const answer =
    params?.answerStream === null
      ? undefined
      : (params?.answerStream ?? createTestDraftStream({ messageId: params?.answerMessageId }));
  const reasoning = createTestDraftStream();
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: lane(answer),
    reasoning: lane(reasoning),
  };
  const sendPayload = vi
    .fn<DelivererOptions["sendPayload"]>()
    .mockResolvedValue({ visibleReplySent: true });
  const editStreamMessage = vi.fn().mockResolvedValue(undefined);
  const recordPromptContextPreview = vi.fn<PromptContextRecord>().mockResolvedValue(true);
  const createPromptContextSequence = () =>
    createTelegramPromptContextProjectionSequence({ record: recordPromptContextPreview });
  const markDelivered = vi.fn();

  const deliverLaneText = createLaneTextDeliverer({
    lanes,
    sendPayload,
    editStreamMessage,
    createPromptContextSequence,
    resolveFinalPayloadCandidate: params?.resolveFinalPayloadCandidate,
    resolveFinalPresentationText: params?.resolveFinalPresentationText,
    log: () => {},
    markDelivered,
  });

  return {
    deliverLaneText,
    lanes,
    answer,
    reasoning,
    sendPayload,
    editStreamMessage,
    recordPromptContextPreview,
    markDelivered,
  };
}

type Harness = ReturnType<typeof createHarness>;
type DeliveryOptions = Parameters<Harness["deliverLaneText"]>[0];

export async function deliverFinalAnswer(
  harness: Harness,
  text: string,
  promptContextSequence?: DeliveryOptions["promptContextSequence"],
) {
  return harness.deliverLaneText({
    laneName: "answer",
    text,
    payload: { text },
    infoKind: "final",
    ...(promptContextSequence ? { promptContextSequence } : {}),
  });
}

export async function deliverProjectedFinalAnswer(harness: Harness, text: string) {
  return deliverFinalAnswer(
    harness,
    text,
    createTelegramPromptContextProjectionSequence({
      source: { transcriptMessageId: "assistant-1" },
      record: harness.recordPromptContextPreview,
    }),
  );
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

export function expectSentPayload(harness: Harness, payload: ReplyPayload, durable: boolean) {
  expect(harness.sendPayload).toHaveBeenCalledWith(
    payload,
    expect.objectContaining({ durable, promptContextSequence: expect.any(Object) }),
  );
}
