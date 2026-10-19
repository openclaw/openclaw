import { expect, it, vi } from "vitest";
import type { createSlackDraftStream } from "../../draft-stream.js";
import type { SlackSendResult } from "../../send.js";
import type { SlackReplyOptionEvent } from "./dispatch.compact-progress.test-support.js";

type FailureProgressScenario = {
  outcome: "completed" | "failed";
  nativeStreaming?: boolean;
  sequence: Array<{ kind: "final"; payload: { text: string; isError?: boolean } }>;
  events: SlackReplyOptionEvent[];
  error?: Error;
};

type FailureProgressHarness = {
  dispatch: (params: {
    cfg?: Record<string, unknown>;
    accountConfig?: Record<string, unknown>;
    ctxPayload?: Record<string, unknown>;
    ackReactionMessageTs?: string;
    ackReactionPromise?: Promise<boolean>;
  }) => Promise<unknown>;
  setScenario: (scenario: FailureProgressScenario) => void;
  progressAccount: (progress: Record<string, unknown>) => Record<string, unknown>;
  useDraftStream: () => { clear: () => Promise<void> };
  createSlackDraftStreamMock: {
    mockImplementationOnce: (implementation: typeof createSlackDraftStream) => unknown;
  };
  sendMessageSlackMock: { mockResolvedValue: (value: SlackSendResult) => unknown };
  finalizeSlackPreviewEditMock: { mockResolvedValue: (value: undefined) => unknown };
  deliverRepliesMock: { mockResolvedValue: (value: SlackSendResult) => unknown };
  normalDeliveryResult: SlackSendResult;
  startSlackStreamMock: unknown;
  stopSlackStreamMock: unknown;
  statusReactionControllerMock: { setError: unknown };
  collectNativeTaskUpdates: () => unknown[];
};

/** Uses the preview suite's reset hooks and transports for failure closeout coverage. */
export function registerSlackFailureProgressTests({
  dispatch,
  setScenario,
  progressAccount,
  useDraftStream,
  createSlackDraftStreamMock,
  sendMessageSlackMock,
  finalizeSlackPreviewEditMock,
  deliverRepliesMock,
  normalDeliveryResult,
  startSlackStreamMock,
  stopSlackStreamMock,
  statusReactionControllerMock,
  collectNativeTaskUpdates,
}: FailureProgressHarness) {
  const noopAsync = async () => {};
  it.each([
    { outcome: "failed", errorReply: false, postsFailure: true, passive: false },
    { outcome: "failed", errorReply: true, postsFailure: false, passive: false },
    { outcome: "completed", errorReply: false, postsFailure: false, passive: false },
    { outcome: "failed", errorReply: true, postsFailure: false, passive: true },
    { outcome: "failed", errorReply: false, postsFailure: false, passive: true },
  ] as const)(
    "closes a quiet tool-only card turn (outcome=$outcome, error reply=$errorReply, passive=$passive)",
    async ({ outcome, errorReply, postsFailure, passive }) => {
      const { createSlackDraftStream } =
        await vi.importActual<typeof import("../../draft-stream.js")>("../../draft-stream.js");
      let draftStream: ReturnType<typeof createSlackDraftStream> | undefined;
      const edit = vi.fn(noopAsync);
      const remove = vi.fn(noopAsync);
      createSlackDraftStreamMock.mockImplementationOnce(
        (params: Parameters<typeof createSlackDraftStream>[0]) => {
          draftStream = createSlackDraftStream({ ...params, edit, remove });
          return draftStream;
        },
      );
      sendMessageSlackMock.mockResolvedValue(normalDeliveryResult);
      finalizeSlackPreviewEditMock.mockResolvedValue(undefined);
      setScenario({
        outcome,
        sequence: errorReply
          ? [{ kind: "final", payload: { text: "Something failed", isError: true } }]
          : [],
        events: [
          { kind: "tool_start", itemId: "tool-1", name: "bash", phase: "start" },
          {
            kind: "checkpoint",
            run: async () => {
              await draftStream?.flush();
              expect(sendMessageSlackMock).not.toHaveBeenCalled();
            },
          },
        ],
      });

      await dispatch({
        accountConfig: { streaming: { mode: "progress", progress: { style: "card" } } },
        ...(passive
          ? {
              cfg: { agents: { defaults: { silentReply: { group: "allow" } } } },
              ctxPayload: { ChatType: "channel", MentionSource: "none" },
            }
          : {}),
      });

      if (postsFailure) {
        const blocks = [
          { type: "section", text: { type: "plain_text", text: "Failed", emoji: false } },
        ];
        expect(sendMessageSlackMock).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          "Failed",
          expect.objectContaining({ blocks }),
        );
        expect(finalizeSlackPreviewEditMock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "Failed", blocks, messageId: "normal-final" }),
        );
        expect(draftStream?.messageId()).toBe("normal-final");
        // Sealed cards ignore late updates and survive dispatch cleanup.
        draftStream?.update("late tool activity");
        await draftStream?.flush();
        expect(sendMessageSlackMock).toHaveBeenCalledTimes(1);
        expect(edit).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
      } else {
        expect(sendMessageSlackMock).not.toHaveBeenCalled();
        expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
      }
      if (errorReply && !passive) {
        expect(deliverRepliesMock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ replies: [{ text: "Something failed", isError: true }] }),
        );
      } else {
        expect(deliverRepliesMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "keeps native progress from authorizing an unaddressed error (useful reply=%s)",
    async (usefulReply) => {
      setScenario({
        nativeStreaming: true,
        outcome: "failed",
        events: [{ kind: "item", progressText: "Working" }],
        sequence: [
          ...(usefulReply
            ? [{ kind: "final" as const, payload: { text: "The query returned three results" } }]
            : []),
          { kind: "final", payload: { text: "Backend unavailable", isError: true } },
        ],
      });
      deliverRepliesMock.mockResolvedValue(normalDeliveryResult);
      await dispatch({
        cfg: {
          agents: { defaults: { silentReply: { group: "allow" } } },
          messages: { statusReactions: { enabled: true } },
        },
        ctxPayload: {
          ChatType: "channel",
          MentionSource: "implicit_thread",
          ImplicitMentionKinds: ["reply_to_bot"],
        },
        accountConfig: progressAccount({ toolProgress: true, nativeTaskCards: true }),
        ackReactionMessageTs: "171234.111",
        ackReactionPromise: Promise.resolve(true),
      });
      expect(startSlackStreamMock).toHaveBeenCalled();
      expect(stopSlackStreamMock).toHaveBeenCalled();
      if (usefulReply) {
        expect(deliverRepliesMock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ replies: [{ text: "Backend unavailable", isError: true }] }),
        );
        expect(statusReactionControllerMock.setError).toHaveBeenCalledOnce();
      } else {
        expect(deliverRepliesMock).not.toHaveBeenCalled();
        expect(collectNativeTaskUpdates()).not.toContainEqual(
          expect.objectContaining({ status: "error" }),
        );
        expect(statusReactionControllerMock.setError).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "discards a generic passive progress card instead of marking it Failed (throw=%s)",
    async (throws) => {
      const draftStream = useDraftStream();
      finalizeSlackPreviewEditMock.mockResolvedValue(undefined);
      setScenario({
        outcome: "failed",
        sequence: [],
        events: [{ kind: "item", progressText: "Working" }],
        error: throws ? new Error("agent dispatch failed") : undefined,
      });
      const result = dispatch({
        cfg: { agents: { defaults: { silentReply: { group: "allow" } } } },
        accountConfig: progressAccount({ style: "card", toolProgress: true }),
        ctxPayload: { ChatType: "channel", MentionSource: "implicit_thread" },
      });
      if (throws) {
        await expect(result).rejects.toThrow("agent dispatch failed");
      } else {
        await result;
      }
      expect(draftStream.clear).toHaveBeenCalled();
      expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
      expect(deliverRepliesMock).not.toHaveBeenCalled();
    },
  );
}
