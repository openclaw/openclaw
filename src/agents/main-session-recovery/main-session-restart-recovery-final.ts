import { normalizePendingFinalDeliveryPayloads } from "../../auto-reply/reply/pending-final-delivery.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { resolveAgentOutboundIdentity } from "../../infra/outbound/identity.js";
import {
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { markSessionCompletedAfterRecoveryCheckpoint } from "./main-session-restart-recovery-checkpoint.js";
import { resolveRestartRecoveryDeliveryContext } from "./main-session-restart-recovery-delivery.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";

/** Transfer an already prepared final to its original durable delivery owner, without inference. */
export async function recoverPreparedFinalDelivery(
  params: MainSessionRecoveryStoreTarget & {
    agentId: string;
    entry: SessionEntry;
    cfg?: OpenClawConfig;
    stateDir?: string;
    lifecycleGeneration?: string;
    shouldContinue?: () => boolean;
  },
): Promise<"settled" | "skipped" | "failed" | "not-applicable"> {
  const { entry } = params;
  const pending = entry.pendingFinalDelivery;
  // Older markers remain with the existing recovery owner. This delivery-only
  // path must not infer a missing original route from the session's latest route.
  if (pending?.kind !== "replayable" || !pending.intentId || !pending.context) {
    return "not-applicable";
  }
  // The command producer captures one batch under one delivery ID. Multi-ID
  // markers do not identify which portion of the saved text each ID owns.
  if (pending.deliveries?.length !== 1) {
    return "skipped";
  }
  const delivery = pending.deliveries[0]!;
  const cfg = params.cfg ?? {};
  const capturedContext = normalizeDeliveryContext(pending.context);
  if (!capturedContext?.channel || !capturedContext.to || !delivery.id) {
    return "skipped";
  }
  const context = resolveRestartRecoveryDeliveryContext({ ...params, cfg });
  if (!context || delivery.state !== "prepared") {
    return "skipped";
  }
  const payloads = normalizePendingFinalDeliveryPayloads([{ text: pending.text }]);
  if (
    payloads.length !== 1 ||
    !payloads[0]?.text?.trim() ||
    payloads[0].mediaUrl ||
    payloads[0].mediaUrls?.length
  ) {
    return "skipped";
  }
  const generation = params.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  const currentEntry = () => loadSessionEntryReadOnly({ ...params, readConsistency: "latest" });
  const assertCurrent = () => {
    const current = currentEntry();
    if (
      params.shouldContinue?.() === false ||
      getAgentEventLifecycleGeneration() !== generation ||
      current?.sessionId !== entry.sessionId ||
      current.lifecycleRevision !== entry.lifecycleRevision ||
      current.activeWriterRunId !== entry.activeWriterRunId ||
      current.mainRestartRecovery?.reservation !== undefined ||
      current.mainRestartRecovery?.foregroundClaims !== undefined ||
      current.status !== "running" ||
      current.abortedLastRun !== true ||
      current.restartRecoveryDeliveryRunId !== entry.restartRecoveryDeliveryRunId ||
      current.restartRecoveryDeliverySourceRunId !== entry.restartRecoveryDeliverySourceRunId ||
      current.pendingFinalDelivery?.intentId !== pending.intentId ||
      deliveryContextKey(normalizeDeliveryContext(current.pendingFinalDelivery?.context)) !==
        deliveryContextKey(capturedContext) ||
      deliveryContextKey(
        resolveRestartRecoveryDeliveryContext({ ...params, cfg, entry: current }),
      ) !== deliveryContextKey(context)
    ) {
      throw new PlatformMessageNotDispatchedError("Prepared final recovery owner changed", {
        cause: undefined,
        retryable: false,
      });
    }
  };
  try {
    const [{ deliverOutboundPayloadsInternal }, { captureDeliveryQueueStateContext }] =
      await Promise.all([
        import("../../infra/outbound/deliver.js"),
        import("../../infra/delivery-queue-sqlite.js"),
      ]);
    assertCurrent();
    await deliverOutboundPayloadsInternal(
      {
        cfg,
        ...context,
        payloads,
        session: { key: params.sessionKey, agentId: params.agentId },
        identity: resolveAgentOutboundIdentity(cfg, params.agentId),
        replyPayloadSendingHook: {
          kind: "final",
          channel: context.channel,
          sessionKey: params.sessionKey,
          runId: entry.restartRecoveryDeliverySourceRunId,
          context: {
            channelId: context.channel,
            accountId: context.accountId,
            conversationId: context.to,
            sessionKey: params.sessionKey,
            runId: entry.restartRecoveryDeliverySourceRunId,
          },
        },
        queuePolicy: "required",
        deliveryIntentId: delivery.id,
        reusePendingDeliveryIntent: true,
        deliveryCompletion: {
          kind: "pending-final",
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          sessionId: entry.sessionId,
          intentId: pending.intentId,
          deliveryId: delivery.id,
          sessionWriterDeliveryAuthority: {
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
            expectedSessionId: entry.sessionId,
            expectedLifecycleRevision: entry.lifecycleRevision,
            expectedWriterRunId: entry.activeWriterRunId,
            ...(entry.restartRecoveryHarnessCompletion
              ? { harnessCompletion: entry.restartRecoveryHarnessCompletion }
              : {}),
          },
        },
        onPlatformSendDispatch: async () => assertCurrent(),
        assertDirectAdapterHandoff: assertCurrent,
      },
      captureDeliveryQueueStateContext(params.stateDir),
    );
    const current = currentEntry();
    if (
      current?.sessionId !== entry.sessionId ||
      current.pendingFinalDelivery?.intentId !== pending.intentId ||
      !current.pendingFinalDelivery.deliveries?.every(
        ({ state }) => state === "delivered" || state === "suppressed",
      )
    ) {
      return "skipped";
    }
    const completion = await markSessionCompletedAfterRecoveryCheckpoint({
      ...params,
      messages: [],
      pendingFinalDeliveryIntentId: pending.intentId,
      reason: "delivered-terminal-receipt",
    });
    return completion.outcome === "completed" ? "settled" : "skipped";
  } catch (error) {
    if (error instanceof PlatformMessageNotDispatchedError && !error.retryable) {
      return "skipped";
    }
    mainSessionRecoveryLog.warn(
      `failed to deliver prepared final ${params.sessionKey}: ${String(error)}`,
    );
    return "failed";
  }
}
