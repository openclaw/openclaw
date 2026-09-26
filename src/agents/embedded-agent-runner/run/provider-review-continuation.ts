import { responsesRequestLifecycle } from "@openclaw/ai/internal/openai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  acceptProviderReviewAcknowledgment,
  assertSessionProviderReviewWorkStart,
  readProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../../sessions/provider-review.js";
import type { StreamFn } from "../../runtime/index.js";

function countUserInputSlots(input: readonly unknown[]): number {
  let count = 0;
  for (const item of input) {
    if (isRecord(item) && item.role === "user") {
      count += 1;
    }
  }
  return count;
}

/** Acknowledgment decorates one request; later tool calls retain ordinary transport behavior. */
export function wrapStreamFnWithProviderReviewContinuation(params: {
  streamFn: StreamFn;
  acknowledgment?: ProviderReviewAcknowledgment;
  runId: string;
  assertCurrent: () => void;
}): StreamFn {
  const acknowledgment = params.acknowledgment;
  if (!acknowledgment) {
    return params.streamFn;
  }
  if (readProviderReviewAcknowledgment(acknowledgment).phase === "accepted") {
    throw new Error("Provider review continuation cannot start another transport attempt");
  }
  let pendingCallStarted = false;
  let acceptedByThisWrapper = false;
  return async (model, context, options) => {
    const transportSignals = new Set<AbortSignal>();
    const assertCurrent = () => {
      options?.signal?.throwIfAborted();
      for (const signal of transportSignals) {
        signal.throwIfAborted();
      }
      params.assertCurrent();
      readProviderReviewAcknowledgment(acknowledgment);
    };
    assertCurrent();
    const snapshot = readProviderReviewAcknowledgment(acknowledgment);
    const assertWorkStart = () =>
      assertSessionProviderReviewWorkStart({
        target: snapshot.target,
        acknowledgment,
        runId: params.runId,
        provider: model.provider,
        model: model.id,
        runtimeId: "openclaw",
        api: model.api,
        assertCurrent,
      });
    await assertWorkStart();
    assertCurrent();
    if (snapshot.phase === "accepted") {
      if (!acceptedByThisWrapper) {
        throw new Error("Provider review continuation belongs to another transport attempt");
      }
      return params.streamFn(model, context, options);
    }
    if (
      pendingCallStarted ||
      model.provider !== "openai" ||
      model.api !== "openai-chatgpt-responses"
    ) {
      throw new Error("Provider review continuation cannot be retried or change transport");
    }
    const message = snapshot.review.review?.continuation?.message;
    const latest = context.messages.at(-1);
    if (!message || latest?.role !== "user") {
      throw new Error("Provider review continuation requires its exact next user input");
    }
    pendingCallStarted = true;
    let payloadPrepared = false;
    let dispatched = false;
    let acceptedResponseId: string | undefined;
    let acceptance: Promise<void> | undefined;
    const requestOptions: NonNullable<Parameters<StreamFn>[2]> = {
      ...options,
      onPayload: async (payload, payloadModel) => {
        if (payloadPrepared) {
          throw new Error("Provider review continuation cannot rebuild or retry its request");
        }
        if (!isRecord(payload) || !Array.isArray(payload.input)) {
          throw new Error("Provider continuation payload has no user input");
        }
        // Hooks may mutate the input array itself, so capture its user slots before awaiting them.
        const userInputSlots = countUserInputSlots(payload.input);
        const replacement = await options?.onPayload?.(payload, payloadModel);
        await assertWorkStart();
        assertCurrent();
        const finalPayload = replacement === undefined ? payload : replacement;
        if (!isRecord(finalPayload) || !Array.isArray(finalPayload.input)) {
          throw new Error("Provider continuation payload has no user input");
        }
        if (
          payloadModel.provider !== snapshot.review.provider ||
          payloadModel.id !== snapshot.review.model ||
          payloadModel.api !== snapshot.review.api ||
          finalPayload.model !== snapshot.review.model
        ) {
          throw new Error("Provider continuation payload changed the reviewed runtime or model");
        }
        if (countUserInputSlots(finalPayload.input) > userInputSlots) {
          throw new Error("Provider continuation payload added user input");
        }
        const lastInput = finalPayload.input.at(-1);
        if (!isRecord(lastInput) || lastInput.role !== "user") {
          throw new Error("Provider continuation payload changed its next user input");
        }
        const rawMetadata = finalPayload.client_metadata;
        if (rawMetadata !== undefined && !isRecord(rawMetadata)) {
          throw new Error("Provider continuation metadata is malformed");
        }
        const metadata = rawMetadata ?? {};
        const rawTurnMetadata = metadata["x-codex-turn-metadata"];
        let turnMetadata: Record<string, unknown> = {};
        if (rawTurnMetadata !== undefined) {
          if (typeof rawTurnMetadata !== "string") {
            throw new Error("Provider continuation turn metadata is malformed");
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawTurnMetadata);
          } catch {
            throw new Error("Provider continuation turn metadata is malformed");
          }
          if (!isRecord(parsed)) {
            throw new Error("Provider continuation turn metadata is malformed");
          }
          turnMetadata = parsed;
        }
        payloadPrepared = true;
        return {
          ...finalPayload,
          input: [
            ...finalPayload.input.slice(0, -1),
            { ...lastInput, content: [{ type: "input_text", text: message }] },
          ],
          client_metadata: {
            ...metadata,
            "x-codex-turn-metadata": JSON.stringify({
              ...turnMetadata,
              misalignment_override: JSON.stringify({ timestamp: Date.now() }),
            }),
          },
        };
      },
    };
    responsesRequestLifecycle.set(requestOptions, {
      assertCurrent,
      beforeDispatch: async (signal) => {
        if (dispatched || !payloadPrepared) {
          throw new Error("Provider review continuation already dispatched or was not prepared");
        }
        if (signal) {
          transportSignals.add(signal);
        }
        await assertWorkStart();
        assertCurrent();
        if (dispatched) {
          throw new Error("Provider review continuation already dispatched");
        }
        dispatched = true;
      },
      accepted: (responseId, signal) => {
        if (signal) {
          transportSignals.add(signal);
        }
        assertCurrent();
        if (!dispatched || (acceptedResponseId && acceptedResponseId !== responseId)) {
          throw new Error("Provider continuation response does not match its request");
        }
        if (!acceptance) {
          acceptedResponseId = responseId;
          acceptance = acceptProviderReviewAcknowledgment(acknowledgment, {
            runId: params.runId,
            assertCurrent,
          }).then(() => {
            assertCurrent();
            acceptedByThisWrapper = true;
          });
        }
        return acceptance;
      },
      settle: async () => {
        await acceptance;
      },
    });
    return params.streamFn(
      model,
      {
        ...context,
        messages: [...context.messages.slice(0, -1), { ...latest, content: message }],
      },
      requestOptions,
    );
  };
}
