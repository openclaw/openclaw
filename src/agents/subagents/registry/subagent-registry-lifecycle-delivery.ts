import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../../../config/sessions/session-store-path.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import { isSilentAgentReplyText } from "../../embedded-agent-runner/message-visibility.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  loadPendingFinalDeliveryPayload,
} from "./subagent-delivery-state.js";
import { capFrozenResultText } from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleCommonContext,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle-context.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { PendingFinalDeliveryPayload } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

const DELIVERY_MIRROR_HISTORY_MAX_CHARS = 128 * 1024;

export const formatAnnounceDeliveryError = (delivery: SubagentAnnounceDeliveryResult): string => {
  const errors = [
    delivery.error,
    delivery.reason,
    ...(delivery.phases ?? []).map((phase) =>
      phase.error ? `${phase.phase}: ${phase.error}` : undefined,
    ),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return errors.length > 0
    ? uniqueStrings(errors).join("; ")
    : `delivery path ${delivery.path} did not complete`;
};

export const recordAnnounceDeliveryResult = (
  entry: SubagentRunRecord,
  delivery: SubagentAnnounceDeliveryResult,
  runs?: ReadonlyMap<string, SubagentRunRecord>,
) => {
  const deliveryState = ensureDeliveryState(entry);
  if (typeof delivery.enqueuedAt === "number") {
    deliveryState.enqueuedAt ??= delivery.enqueuedAt;
  }
  if (!delivery.delivered && delivery.disposition !== "intentional_non_delivery") {
    if (delivery.reason === "message_tool_delivery_missing") {
      deliveryState.lastDropReason = "message_tool_delivery_missing";
    } else if (
      delivery.reason === "steer_dropped" ||
      delivery.phases?.some((phase) => phase.reason === "steer_dropped")
    ) {
      deliveryState.lastDropReason = "steer_dropped";
    } else if (delivery.path === "none") {
      deliveryState.lastDropReason = "sink_unavailable";
    }
  }
  if (delivery.delivered) {
    const deliveredAt =
      typeof delivery.deliveredAt === "number" ? delivery.deliveredAt : Date.now();
    deliveryState.deliveredAt = deliveredAt;
    deliveryState.lastDropReason = undefined;
    const requesterTurnRunId = entry.requesterTurnRunId?.trim();
    if (
      delivery.path === "direct" &&
      delivery.requesterVisibleFinalDelivered &&
      requesterTurnRunId
    ) {
      const siblings = [...(runs?.values() ?? [])].filter(
        (sibling) =>
          sibling.requesterSessionKey === entry.requesterSessionKey &&
          sibling.requesterTurnRunId === requesterTurnRunId &&
          sibling.expectsCompletionMessage === true,
      );
      if (
        siblings.some((sibling) => isSameSubagentRunOwner(sibling, entry)) &&
        siblings.every(
          (sibling) =>
            sibling.execution.status === "terminal" &&
            hasSubagentRunEnded(sibling) &&
            (isSameSubagentRunOwner(sibling, entry) || sibling.delivery?.status === "delivered"),
        )
      ) {
        // Bind final evidence before yielding; direct delivery is fenced once a yield is frozen.
        deliveryState.requesterVisibleFinal = {
          requesterTurnRunId,
          batchRunIds: siblings.map((sibling) => sibling.runId).toSorted(),
        };
      }
    }
  }
  deliveryState.disposition =
    delivery.disposition ?? (delivery.delivered ? "delivered" : "retryable");
};

export const hasPriorRequesterDeliveryMirror = async (
  params: SubagentLifecycleOptions,
  entry: SubagentRunRecord,
): Promise<number | undefined> => {
  const expectedText = extractTextFromChatContent(entry.completion?.resultText, { joinWith: "" });
  if (
    entry.completionTarget === "parent" ||
    entry.expectsCompletionMessage !== true ||
    expectedText == null
  ) {
    return undefined;
  }
  const mirrorNotBefore = entry.execution.startedAt ?? entry.createdAt;
  const mirrorNotAfter = Date.now() + 30_000;
  const expectedIdempotencyKey = buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
    }),
  );
  const isExpectedMirrorIdempotencyKey = (value: unknown): boolean =>
    typeof value === "string" &&
    (value === expectedIdempotencyKey ||
      value.startsWith(`${expectedIdempotencyKey}:internal-source-reply:`) ||
      value.startsWith(`${expectedIdempotencyKey}:message-tool:internal-source-reply:`) ||
      value.startsWith(`${entry.runId}:message-tool:`) ||
      value.startsWith(`${entry.runId}:internal-source-reply:`));
  try {
    const history = await withPluginRuntimeGatewayContextResolver(
      getGatewayContextResolver(entry),
      () =>
        params.callGateway<{
          messages?: unknown[];
        }>({
          method: "chat.history",
          params: {
            sessionKey: entry.requesterSessionKey,
            limit: 25,
            maxChars: DELIVERY_MIRROR_HISTORY_MAX_CHARS,
          },
          timeoutMs: 5_000,
        }),
    );
    const mirror = history.messages?.find((message) => {
      if (!message || typeof message !== "object") {
        return undefined;
      }
      const record = message as Record<string, unknown>;
      const timestamp = record.timestamp;
      if (
        typeof timestamp !== "number" ||
        !Number.isFinite(timestamp) ||
        timestamp < mirrorNotBefore ||
        timestamp > mirrorNotAfter ||
        !isExpectedMirrorIdempotencyKey(record.idempotencyKey)
      ) {
        return undefined;
      }
      const text = extractTextFromChatContent(record.content, { joinWith: "" });
      return (
        record.role === "assistant" &&
        record.provider === "openclaw" &&
        record.model === "delivery-mirror" &&
        text === expectedText
      );
    });
    return mirror ? (mirror as { timestamp: number }).timestamp : undefined;
  } catch {
    return undefined;
  }
};

export const captureSubagentRunResult = async (
  context: SubagentLifecycleCommonContext,
  entry: SubagentRunRecord,
  outcome: SubagentRunOutcome,
  assertCurrent: () => void,
): Promise<
  | {
      resultText: string | null;
      capturedAt: number;
      outcome: SubagentRunOutcome;
      transcriptTarget: SubagentRunRecord["execution"]["transcriptTarget"];
    }
  | undefined
> => {
  const params = context.options;
  const result = (resultText: string | null) => ({
    resultText,
    capturedAt: Date.now(),
    outcome,
    transcriptTarget: entry.execution.transcriptTarget,
  });
  const currentResult = entry.completion?.resultText;
  if (currentResult !== undefined && !(entry.killReconciliation && !currentResult?.trim())) {
    return result(currentResult);
  }
  if (outcome.status === "error") {
    return result(null);
  }
  const isOwnerCurrent = () => {
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    return (
      current !== undefined &&
      current.pauseReason !== "sessions_yield" &&
      !context.newerGenerationOwnsSession(current)
    );
  };
  const assertCaptureCurrent = () => {
    assertCurrent();
    if (!isOwnerCurrent()) {
      throw new Error("Subagent completion capture lost its original owner");
    }
  };
  let resultText: string | null;
  try {
    const transcriptTarget = entry.execution.transcriptTarget;
    const agentId =
      transcriptTarget?.agentId ??
      resolveSubagentChildSessionOwner(entry, params.getRuntimeConfig()).agentId;
    const sessionKey = transcriptTarget?.sessionKey ?? entry.childSessionKey;
    const configuredStorePath = agentId
      ? (transcriptTarget?.storePath ??
        resolveSessionStorePathCore(params.getRuntimeConfig().session?.store, { agentId }))
      : undefined;
    const storePath = configuredStorePath
      ? resolveSessionStorePathForScope({
          agentId,
          sessionKey,
          storePath: configuredStorePath,
        })
      : undefined;
    const capture = async (sessionId: string | undefined) => {
      assertCaptureCurrent();
      const sessionTarget: SessionTranscriptRuntimeTarget | undefined =
        agentId && sessionId && storePath
          ? { agentId, sessionId, sessionKey, storePath }
          : undefined;
      const capturedReply = await withPluginRuntimeGatewayContextResolver(
        getGatewayContextResolver(entry),
        () =>
          params.captureSubagentCompletionReply(entry.childSessionKey, {
            waitForReply: entry.expectsCompletionMessage === true,
            outcome,
            ...(sessionTarget ? { sessionTarget } : {}),
          }),
      );
      assertCaptureCurrent();
      return capturedReply;
    };
    const captured =
      !transcriptTarget?.sessionId && agentId && storePath
        ? await withSessionEntryReadOnlyInWorker(
            { agentId, sessionKey, storePath },
            assertCaptureCurrent,
            async (read, reader) => {
              if (!read.ok) {
                throw read.error;
              }
              reader.assertCurrent();
              return capture(read.value?.sessionId);
            },
          )
        : await capture(transcriptTarget?.sessionId);
    resultText = captured?.trim() ? capFrozenResultText(captured) : null;
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    if (!isOwnerCurrent()) {
      return undefined;
    }
    assertCurrent();
    resultText = null;
  }
  if (!isOwnerCurrent()) {
    return undefined;
  }
  assertCurrent();
  return result(resultText);
};

export const refreshFrozenResultFromSession = async (
  context: SubagentLifecycleCommonContext,
  sessionKey: string,
): Promise<boolean> => {
  const params = context.options;
  const key = sessionKey.trim();
  if (!key) {
    return false;
  }
  // A paused row's result was cleared on yield; later session text belongs to the next turn.
  const candidates: SubagentRunRecord[] = [];
  for (const entry of params.runs.values()) {
    if (
      entry.childSessionKey === key &&
      entry.expectsCompletionMessage === true &&
      typeof entry.execution.endedAt === "number" &&
      typeof entry.cleanupCompletedAt !== "number" &&
      entry.pauseReason !== "sessions_yield" &&
      entry.execution.outcome?.status !== "error"
    ) {
      candidates.push(entry);
    }
  }
  const entry = candidates.toSorted(compareSubagentRunGeneration).at(-1);
  if (!entry || context.newerGenerationOwnsSession(entry)) {
    return false;
  }
  const stateContext = captureOpenClawStateWorkerContext();
  const previousResultText = entry.completion?.resultText;
  const previousCapturedAt = entry.completion?.capturedAt;
  const isCurrent = (current = getCurrentSubagentRunOwner(params.runs, entry)) =>
    current !== undefined &&
    current.pauseReason !== "sessions_yield" &&
    current.cleanupCompletedAt === undefined &&
    current.completion?.resultText === previousResultText &&
    current.completion?.capturedAt === previousCapturedAt &&
    !context.newerGenerationOwnsSession(current);

  let captured: string | undefined;
  try {
    captured = await withPluginRuntimeGatewayContextResolver(getGatewayContextResolver(entry), () =>
      params.captureSubagentCompletionReply(sessionKey),
    );
  } catch {
    return false;
  }
  const trimmed = captured?.trim();
  if (!trimmed || isSilentAgentReplyText(trimmed)) {
    return false;
  }
  // Reply capture yields while registration can transfer session ownership.
  // Only the exact row and generation that started capture may commit its text.
  assertSubagentRegistryWriteSourceCurrent(stateContext);
  if (
    !isCurrent() ||
    entry.completion?.resultText !== previousResultText ||
    entry.completion?.capturedAt !== previousCapturedAt
  ) {
    return false;
  }

  const nextFrozen = capFrozenResultText(trimmed);
  if (entry.completion?.resultText === nextFrozen) {
    return false;
  }
  await commitSubagentLifecycleMutation(context, {
    entry,
    stateContext,
    assertCurrent(current) {
      if (!isCurrent(current)) {
        throw new Error("Subagent frozen-result owner changed before persistence.");
      }
    },
    mutate(draft) {
      const completion = ensureCompletionState(draft);
      completion.resultText = nextFrozen;
      completion.capturedAt = Date.now();
    },
  });
  return true;
};

export const markPendingFinalDelivery = (args: { entry: SubagentRunRecord; error?: string }) => {
  const now = Date.now();
  const payload: PendingFinalDeliveryPayload = loadPendingFinalDeliveryPayload(args.entry);

  const delivery = ensureDeliveryState(args.entry);
  delivery.status = "pending";
  delivery.createdAt ??= now;
  delivery.lastAttemptAt = now;
  delivery.attemptCount = (delivery.attemptCount ?? 0) + 1;
  delivery.lastError = args.error ?? null;
  delivery.payload = payload;
};

export const refreshPendingFinalDeliveryPayload = (entry: SubagentRunRecord): boolean => {
  const delivery = entry.delivery;
  if (
    !delivery?.payload ||
    delivery.status === "delivered" ||
    typeof delivery.announcedAt === "number"
  ) {
    return false;
  }
  delivery.payload = {
    ...delivery.payload,
    startedAt: entry.execution.startedAt,
    endedAt: entry.execution.endedAt,
    outcome: entry.execution.outcome,
    terminalReply: entry.completion?.terminalReply,
  };
  return true;
};
