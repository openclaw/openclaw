import { isDeepStrictEqual } from "node:util";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import { readCodexProviderRefusal } from "./event-projector-values.js";
import { isJsonObject, type CodexTurnStartParams } from "./protocol.js";

type ProviderReviewAcknowledgment = NonNullable<
  AgentHarnessAttemptParamsV2["providerReviewAcknowledgment"]
>;

/** Reconcile the acknowledged failure with the native thread immediately before turn/start. */
export async function prepareCodexProviderReviewContinuation(params: {
  acknowledgment?: ProviderReviewAcknowledgment;
  client: Pick<CodexAppServerClient, "request" | "addNotificationHandler">;
  turnStartParams: CodexTurnStartParams;
  provider: string;
  model: string;
  api: string;
  signal: AbortSignal;
  timeoutMs: number;
  assertCurrent: () => void;
}) {
  const acknowledgment = params.acknowledgment;
  if (!acknowledgment) {
    return undefined;
  }
  let nativeChanged = false;
  let dispatched = false;
  let dispose = () => {};
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    acknowledgment.read();
    if (nativeChanged) {
      throw new Error("The native provider review changed before dispatch");
    }
  };
  assertCurrent();
  const snapshot = acknowledgment.read();
  if (snapshot.phase === "accepted") {
    throw new Error("Provider review continuation cannot start another native turn");
  }
  const assertWorkStart = () =>
    acknowledgment.assertRuntime({
      provider: params.provider,
      model: params.model,
      runtimeId: "codex",
      api: params.api,
      assertCurrent,
    });
  await assertWorkStart();
  assertCurrent();
  const { review } = snapshot;
  if (review.nativeThreadId !== params.turnStartParams.threadId || !review.review?.continuation) {
    throw new Error("Provider review no longer matches the native thread");
  }
  dispose = params.client.addNotificationHandler((notification) => {
    const event = notification.params;
    if (!isJsonObject(event) || event.threadId !== review.nativeThreadId) {
      return;
    }
    if (notification.method === "turn/started") {
      nativeChanged = true;
    } else if (
      notification.method === "turn/completed" ||
      (notification.method === "error" && event.willRetry !== true)
    ) {
      const turn = isJsonObject(event.turn) ? event.turn : undefined;
      const turnId = turn?.id ?? event.turnId;
      const error = isJsonObject(turn?.error)
        ? turn.error
        : isJsonObject(event.error)
          ? event.error
          : undefined;
      const failure = readCodexProviderRefusal(
        typeof error?.message === "string" ? error.message : undefined,
        error?.codexErrorInfo,
        { misalignment: error?.misalignment },
      );
      if (
        turnId !== review.nativeTurnId ||
        (turn && turn.status !== "failed") ||
        failure?.category !== "misalignment" ||
        (error?.misalignment != null && !isDeepStrictEqual(failure.review, review.review))
      ) {
        nativeChanged = true;
      }
    }
  });
  try {
    const page = await params.client.request(
      "thread/turns/list",
      {
        threadId: params.turnStartParams.threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
      { signal: params.signal, timeoutMs: params.timeoutMs, assertCurrent },
    );
    assertCurrent();
    const latest = page.data[0];
    const refusal =
      latest &&
      readCodexProviderRefusal(latest.error?.message, latest.error?.codexErrorInfo, {
        misalignment: latest.error?.misalignment,
      });
    if (
      page.data.length !== 1 ||
      !latest ||
      latest.id !== review.nativeTurnId ||
      (latest.threadId !== undefined && latest.threadId !== params.turnStartParams.threadId) ||
      latest.status !== "failed" ||
      refusal?.category !== "misalignment" ||
      // Durable Codex turn pages omit findings; supplied replacement findings must still match.
      (latest.error?.misalignment != null && !isDeepStrictEqual(refusal.review, review.review))
    ) {
      throw new Error("The native provider review changed; refresh the findings before continuing");
    }
    await assertWorkStart();
    assertCurrent();
    const message = review.review.continuation.message;
    params.turnStartParams.input = [{ type: "text", text: message, text_elements: [] }];
    params.turnStartParams.responsesapiClientMetadata = {
      ...params.turnStartParams.responsesapiClientMetadata,
      misalignment_override: JSON.stringify({ timestamp: Date.now() }),
    };
    return {
      dispose,
      dispatch: () => {
        assertCurrent();
        if (dispatched) {
          throw new Error("Provider review continuation already dispatched");
        }
        dispatched = true;
        dispose();
      },
      accept: async (turnId: string) => {
        assertCurrent();
        if (!dispatched) {
          throw new Error("Provider review continuation has not dispatched");
        }
        await acknowledgment.acceptNativeTurn({
          nativeThreadId: params.turnStartParams.threadId,
          nativeTurnId: turnId,
          assertCurrent,
        });
        assertCurrent();
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
