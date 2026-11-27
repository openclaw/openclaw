import type { TelegramDispatchTurn as Turn } from "./bot-message-dispatch.types.js";
import { cleanupDrafts, ingestDraftLaneSegments } from "./bot-message-dispatch-draft.js";
import { describe, expect, it, vi } from "vitest";

type RetainedPage = { messageId: number; text: string };

function makeTurn(
  params: {
    finalSuppressed?: boolean;
    answerFinalized?: boolean;
    reasoningFinalized?: boolean;
    answerPages?: RetainedPage[];
    reasoningPages?: RetainedPage[];
    dispatchError?: unknown;
    agentRunFailed?: boolean;
    deleteMessage?: (chatId: number, messageId: number) => Promise<boolean>;
    streamMode?: "partial" | "progress";
  } = {},
) {
  const deleteMessage = params.deleteMessage ?? vi.fn(async () => true);
  const cleanup = vi.fn(async () => undefined);
  const lane = (finalized: boolean, pages: RetainedPage[] = []) => ({
    stream: undefined,
    lastPartialText: "",
    hasStreamedMessage: false,
    finalized,
    retainedPromptContextPages: [...pages],
  });
  const turn = {
    streamMode: params.streamMode ?? "partial",
    context: { chatId: 123 },
    bot: { api: { deleteMessage } },
    previewLifecycle: {
      finalSuppressed: params.finalSuppressed ?? false,
      cleanup,
    },
    dispatchError: params.dispatchError,
    agentRunFailed: params.agentRunFailed,
    answerLane: lane(params.answerFinalized ?? false, params.answerPages ?? []),
    reasoningLane: lane(params.reasoningFinalized ?? false, params.reasoningPages ?? []),
  } as unknown as Turn;
  return { turn, deleteMessage, cleanup };
}

describe("cleanupDrafts suppressed-final reclamation", () => {
  it("deletes retained pages of non-finalized lanes when the final is silent", async () => {
    const answerPages = [
      { messageId: 3359, text: "page one" },
      { messageId: 3360, text: "page two" },
    ];
    const reasoningPages = [{ messageId: 3361, text: "reasoning page" }];
    const { turn, deleteMessage, cleanup } = makeTurn({
      finalSuppressed: true,
      answerPages,
      reasoningPages,
    });
    await cleanupDrafts(turn, false);
    expect(deleteMessage).toHaveBeenCalledTimes(3);
    expect(deleteMessage.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [123, 3359],
      [123, 3360],
      [123, 3361],
    ]);
    expect(turn.answerLane.retainedPromptContextPages).toEqual([]);
    expect(turn.reasoningLane.retainedPromptContextPages).toEqual([]);
    expect(cleanup).toHaveBeenCalled();
  });

  it("keeps custody of finalized lanes even on a silent final", async () => {
    const { turn, deleteMessage } = makeTurn({
      finalSuppressed: true,
      answerFinalized: true,
      answerPages: [{ messageId: 3362, text: "accepted block page" }],
      reasoningPages: [{ messageId: 3363, text: "orphaned reasoning page" }],
    });
    await cleanupDrafts(turn, false);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(123, 3363);
    expect(turn.answerLane.retainedPromptContextPages).toEqual([
      { messageId: 3362, text: "accepted block page" },
    ]);
  });

  it("leaves delivered turns untouched", async () => {
    const { turn, deleteMessage, cleanup } = makeTurn({
      answerPages: [{ messageId: 3364, text: "delivered page" }],
    });
    await cleanupDrafts(turn, false);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(turn.answerLane.retainedPromptContextPages).toEqual([{ messageId: 3364, text: "delivered page" }]);
    expect(cleanup).toHaveBeenCalled();
  });

  it("skips reclamation when the turn failed", async () => {
    const { turn, deleteMessage, cleanup } = makeTurn({
      finalSuppressed: true,
      agentRunFailed: true,
      answerPages: [{ messageId: 3365, text: "kept for inspection" }],
    });
    await cleanupDrafts(turn, false);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith({ failed: true });
  });

  it("treats supersession as a failure and keeps the artifacts", async () => {
    const { turn, deleteMessage, cleanup } = makeTurn({
      finalSuppressed: true,
      answerPages: [{ messageId: 3366, text: "superseded page" }],
    });
    await cleanupDrafts(turn, true);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith({ failed: true });
  });

  it("logs failed or unconfirmed deletes without failing the turn", async () => {
    const rejecting = makeTurn({
      finalSuppressed: true,
      answerPages: [{ messageId: 3367, text: "page" }],
      deleteMessage: vi.fn(async () => {
        throw new Error("flood");
      }),
    });
    await expect(cleanupDrafts(rejecting.turn, false)).resolves.toBeUndefined();
    const unconfirmed = makeTurn({
      finalSuppressed: true,
      answerPages: [{ messageId: 3368, text: "page" }],
      deleteMessage: vi.fn(async () => false),
    });
    await expect(cleanupDrafts(unconfirmed.turn, false)).resolves.toBeUndefined();
    expect(unconfirmed.cleanup).toHaveBeenCalled();
  });
});

describe("ingestDraftLaneSegments emitsReasoningInContent gating", () => {
  function makePartialTurn(emitsReasoningInContent: boolean) {
    const update = vi.fn();
    const updateLazy = vi.fn();
    const turn = {
      streamMode: "partial",
      emitsReasoningInContent,
      lastAnswerPartialText: "",
      activeAnswerDraftIsToolProgressOnly: false,
      rotateAnswerLaneWhenQueuedBlocksSettle: false,
      queuedAnswerBlockRotations: [],
      answerLane: {
        stream: { update, updateLazy },
        lastPartialText: "",
        hasStreamedMessage: false,
        finalized: false,
        retainedPromptContextPages: [],
      },
    } as unknown as Turn;
    return { turn, update, updateLazy };
  }

  it("skips the answer preview for flagged models", async () => {
    const { turn, update, updateLazy } = makePartialTurn(true);
    await ingestDraftLaneSegments(turn, { text: "Leaked reasoning content stream" });
    expect(updateLazy).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(turn.answerLane.hasStreamedMessage).toBe(false);
  });

  it("keeps scheduling the answer preview for unflagged models", async () => {
    const { turn, updateLazy } = makePartialTurn(false);
    await ingestDraftLaneSegments(turn, { text: "Normal streamed answer" });
    expect(updateLazy).toHaveBeenCalledTimes(1);
  });
});
