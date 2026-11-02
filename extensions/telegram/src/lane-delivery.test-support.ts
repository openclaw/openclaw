import assert from "node:assert/strict";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { expect, vi } from "vitest";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import {
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
} from "./lane-delivery-text-deliverer.js";
import { createTelegramPromptContextProjectionSequence } from "./prompt-context-projection.js";

type PromptContextRecord = Parameters<
  typeof createTelegramPromptContextProjectionSequence
>[0]["record"];
type DelivererOptions = Parameters<typeof createLaneTextDeliverer>[0];

const emptyLane = { lastPartialText: "", hasStreamedMessage: false, finalized: false };
const lane = (stream: DraftLaneState["stream"]): DraftLaneState => ({
  ...emptyLane,
  stream,
  retainedPromptContextPages: [],
});

export function createHarness({
  answerStream,
  answerMessageId,
  ...options
}: {
  answerMessageId?: number;
  answerStream?: DraftLaneState["stream"] | null;
  resolveFinalPayloadCandidate?: DelivererOptions["resolveFinalPayloadCandidate"];
  resolveFinalPresentationText?: DelivererOptions["resolveFinalPresentationText"];
} = {}) {
  const answer =
    answerStream === null
      ? undefined
      : (answerStream ?? createTestDraftStream({ messageId: answerMessageId }));
  const reasoning = createTestDraftStream();
  const lanes = { answer: lane(answer), reasoning: lane(reasoning) };
  const mocks = {
    sendPayload: vi.fn<DelivererOptions["sendPayload"]>(async () => ({ visibleReplySent: true })),
    editStreamMessage: vi.fn().mockResolvedValue(undefined),
    recordPromptContextPreview: vi.fn<PromptContextRecord>().mockResolvedValue(true),
    markDelivered: vi.fn(),
  };
  const deliverLaneText = createLaneTextDeliverer({
    ...mocks,
    lanes,
    createPromptContextSequence: () =>
      createTelegramPromptContextProjectionSequence({ record: mocks.recordPromptContextPreview }),
    ...options,
    log: () => {},
  });

  return { deliverLaneText, lanes, answer, reasoning, ...mocks };
}

type Harness = ReturnType<typeof createHarness>;
type DeliveryOptions = Parameters<Harness["deliverLaneText"]>[0];

export function deliver(harness: Harness, text: string, overrides: Partial<DeliveryOptions> = {}) {
  return harness.deliverLaneText({
    laneName: "answer",
    text,
    payload: { text },
    infoKind: "final",
    ...overrides,
  });
}

export async function deliverProjectedFinalAnswer(harness: Harness, text: string) {
  return deliver(harness, text, {
    promptContextSequence: createTelegramPromptContextProjectionSequence({
      source: { transcriptMessageId: "assistant-1" },
      record: harness.recordPromptContextPreview,
    }),
  });
}

export function expectPreviewFinalized(result: LaneDeliveryResult) {
  assert(result.kind === "preview-finalized", `expected preview-finalized, got ${result.kind}`);
  return result.delivery;
}

export function expectRecordedPreview(
  recordPromptContextPreview: ReturnType<typeof vi.fn>,
  index: number,
  params: { messageId?: number; text: string; partIndex: number; finalPart: boolean },
) {
  const { messageId = 999, text, ...projection } = params;
  expect(recordPromptContextPreview.mock.calls[index]?.[0]).toEqual({
    messageId,
    text,
    projection: { transcriptMessageId: "assistant-1", ...projection },
  });
}

export function expectSentPayload(harness: Harness, payload: ReplyPayload, durable: boolean) {
  expect(harness.sendPayload).toHaveBeenCalledWith(
    payload,
    expect.objectContaining({ durable, promptContextSequence: expect.any(Object) }),
  );
}
