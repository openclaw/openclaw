import {
  PartialReplyDeliveryError,
  type PendingReplyDeliveryPart,
} from "openclaw/plugin-sdk/error-runtime";
import {
  createFeishuPartialReplyDeliveryError,
  FeishuReplyDeliveryProgressError,
  mergeFeishuReplyDeliveryResults,
  noVisibleFeishuReplyDelivery,
  toFeishuReplyDeliveryError,
  type FeishuReplyDeliveryResult,
} from "./reply-delivery-result.js";

type PendingCompletion = {
  result: FeishuReplyDeliveryResult;
  failure?: {
    error: unknown;
    pendingParts: readonly PendingReplyDeliveryPart[];
  };
  resolve: (result: FeishuReplyDeliveryResult) => void;
  reject: (error: unknown) => void;
};

function createPendingCompletion(
  result: FeishuReplyDeliveryResult,
  failure?: PendingCompletion["failure"],
): {
  completion: Promise<FeishuReplyDeliveryResult>;
  pending: PendingCompletion;
} {
  let resolveCompletion!: PendingCompletion["resolve"];
  let rejectCompletion!: PendingCompletion["reject"];
  const completion = new Promise<FeishuReplyDeliveryResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);
  return {
    completion,
    pending: {
      result,
      ...(failure ? { failure } : {}),
      resolve: resolveCompletion,
      reject: rejectCompletion,
    },
  };
}

export function createFeishuStreamingDeliveryCompletionQueue(
  attachDeliveryCompletion: <T extends object>(result: T, completion: Promise<unknown>) => T,
  finalize: (options?: { markClosedForReply?: boolean }) => Promise<FeishuReplyDeliveryResult>,
  onIdle: () => void,
) {
  const pending: PendingCompletion[] = [];
  let idleSideEffects: Promise<void> = Promise.resolve();
  return {
    waitForIdle: async () => await idleSideEffects,
    defer: (result: FeishuReplyDeliveryResult = noVisibleFeishuReplyDelivery) => {
      const { completion, pending: pendingCompletion } = createPendingCompletion(result);
      pending.push(pendingCompletion);
      return attachDeliveryCompletion({ visibleReplySent: false }, completion);
    },
    deferFailure: (
      error: unknown,
      result: FeishuReplyDeliveryResult = noVisibleFeishuReplyDelivery,
      pendingParts: readonly PendingReplyDeliveryPart[] = [],
    ) => {
      const owner = toFeishuReplyDeliveryError(error);
      const { completion, pending: pendingCompletion } = createPendingCompletion(result, {
        error,
        pendingParts,
      });
      pending.push(pendingCompletion);
      return attachDeliveryCompletion(owner, completion);
    },
    queueIdle: (options?: { markClosedForReply?: boolean }) => {
      const completions = pending.splice(0);
      const next = idleSideEffects.then(async () => {
        try {
          const finalized = await finalize(options);
          for (const completion of completions) {
            const result = mergeFeishuReplyDeliveryResults([finalized, completion.result]);
            if (completion.failure) {
              completion.reject(
                createFeishuPartialReplyDeliveryError(
                  completion.failure.error,
                  result,
                  completion.failure.pendingParts,
                ),
              );
            } else {
              completion.resolve(result);
            }
          }
        } catch (error: unknown) {
          for (const completion of completions) {
            const finalizedFailure = error instanceof PartialReplyDeliveryError ? error : undefined;
            const finalizationProgress =
              error instanceof FeishuReplyDeliveryProgressError ? error : undefined;
            const visibleResult = mergeFeishuReplyDeliveryResults([
              ...(finalizedFailure ? [finalizedFailure.deliveryResult] : []),
              completion.result,
            ]);
            if (visibleResult.visibleReplySent) {
              // Supplemental media is already native-visible when card finalization fails.
              // Keep the failure truthful while preserving its provider identity.
              const cause = completion.failure
                ? new AggregateError(
                    [completion.failure.error, error],
                    "Feishu reply delivery and finalization failed",
                  )
                : (finalizationProgress?.cause ?? error);
              completion.reject(
                createFeishuPartialReplyDeliveryError(cause, visibleResult, [
                  ...(finalizedFailure?.pendingParts ?? []),
                  ...(finalizationProgress?.pendingParts ?? []),
                  ...(completion.failure?.pendingParts ?? []),
                ]),
              );
            } else {
              completion.reject(
                completion.failure
                  ? new AggregateError(
                      [completion.failure.error, error],
                      "Feishu reply delivery and finalization failed",
                    )
                  : error,
              );
            }
          }
          throw error;
        } finally {
          onIdle();
        }
      });
      idleSideEffects = next.catch(() => undefined);
      return next;
    },
  };
}
