import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import {
  applySessionEntryReplacements,
  persistSessionTranscriptTurn,
  type SessionTranscriptTurnLifecyclePatch,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.js";
import { getOwedHarnessCompletionTask } from "../agent-harness-completion-recovery.js";
import {
  getTranscriptMessageRole as getMessageRole,
  isTerminalSilentAssistantMessage,
  readTerminalSourceReplyDeliveryMirror,
} from "../embedded-agent-runner/message-visibility.js";
import { buildMainSessionRecoveryClearPatch } from "./main-session-recovery-clear.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { isRestartAbortTailArtifact } from "./main-session-restart-recovery-resume-policy.js";
import {
  mainSessionRecoveryLog,
  resolveRestartRecoveryTerminalClientRunId,
} from "./main-session-restart-recovery-shared.js";

export async function reconcileInvalidHarnessCompletion(
  params: MainSessionRecoveryStoreTarget & {
    entry: SessionEntry;
  },
): Promise<{ outcome: "reconciled" } | { outcome: "changed"; entry: SessionEntry | null }> {
  let didReconcile = false;
  const current = await updateSessionEntry(
    params,
    (entry) => {
      const claim = entry.restartRecoveryHarnessCompletion;
      if (
        entry.sessionId !== params.entry.sessionId ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        !claim ||
        claim.taskId !== params.entry.restartRecoveryHarnessCompletion?.taskId ||
        entry.restartRecoveryDeliveryRunId !== params.entry.restartRecoveryDeliveryRunId ||
        entry.restartRecoveryDeliverySourceRunId !==
          params.entry.restartRecoveryDeliverySourceRunId ||
        getOwedHarnessCompletionTask(claim, entry)
      ) {
        return null;
      }
      didReconcile = true;
      const endedAt = Date.now();
      return {
        ...buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: false }),
        ...buildMainSessionRecoveryClearPatch(entry),
        status: "killed",
        lifecycleRunId: undefined,
        lastRunId: resolveRestartRecoveryTerminalClientRunId(entry),
        abortedLastRun: false,
        endedAt,
        lastRunError: undefined,
        runtimeMs:
          typeof entry.startedAt === "number" ? Math.max(0, endedAt - entry.startedAt) : undefined,
        updatedAt: endedAt,
      };
    },
    { requireWriteSuccess: true },
  );
  if (didReconcile) {
    mainSessionRecoveryLog.info(
      `retired invalid harness completion recovery: ${params.sessionKey}`,
    );
    return { outcome: "reconciled" };
  }
  return { outcome: "changed", entry: current };
}

function findSourceTurnRange(params: {
  continuationRunId?: string;
  messages: readonly unknown[];
  sourceTurnId: string;
}): { startIndex: number; endIndex: number } | undefined {
  const sourceUserTurnId = buildRunUserTurnIdempotencyKey(params.sourceTurnId);
  const sourceTurnIds = new Set([params.sourceTurnId, sourceUserTurnId]);
  const continuationTurnId = params.continuationRunId
    ? buildRunUserTurnIdempotencyKey(params.continuationRunId)
    : undefined;
  const startIndex = params.messages.findLastIndex(
    (message) =>
      getMessageRole(message) === "user" &&
      sourceTurnIds.has(
        normalizeOptionalString(asOptionalObjectRecord(message)?.idempotencyKey) ?? "",
      ),
  );
  if (startIndex === -1) {
    return undefined;
  }
  const endIndex = params.messages.findIndex((message, index) => {
    if (index <= startIndex || getMessageRole(message) !== "user") {
      return false;
    }
    const idempotencyKey = normalizeOptionalString(asOptionalObjectRecord(message)?.idempotencyKey);
    // Late media and the exact restart continuation extend the same logical source turn.
    return !(
      idempotencyKey === `${params.sourceTurnId}:late-media` ||
      idempotencyKey === continuationTurnId ||
      (continuationTurnId !== undefined && idempotencyKey === `${continuationTurnId}:late-media`)
    );
  });
  return { startIndex, endIndex: endIndex === -1 ? params.messages.length : endIndex };
}

function readToolCallId(message: Record<string, unknown>): string | undefined {
  return [
    message.toolCallId,
    message.toolUseId,
    message.tool_call_id,
    message.tool_use_id,
    message.callId,
    message.call_id,
  ]
    .map(normalizeOptionalString)
    .find(Boolean);
}

function readAssistantToolCalls(message: unknown): Record<string, unknown>[] | undefined {
  const content = asOptionalObjectRecord(message)?.content;
  if (getMessageRole(message) !== "assistant" || !Array.isArray(content)) {
    return undefined;
  }
  return content.flatMap((block) => {
    const record = asOptionalObjectRecord(block);
    const type = normalizeOptionalString(record?.type);
    return record && (type === "toolCall" || type === "toolUse" || type === "tool_use")
      ? [record]
      : [];
  });
}

function isSuccessfulMessageToolResult(message: unknown, toolCallId: string): boolean {
  const role = getMessageRole(message);
  const record = asOptionalObjectRecord(message);
  return (
    record !== undefined &&
    (role === "tool" || role === "toolResult") &&
    readToolCallId(record) === toolCallId &&
    normalizeOptionalString(record.toolName) === "message" &&
    record.isError !== true
  );
}

function canReconcileTerminalDeliveryAtSourceTurnTail(params: {
  messages: readonly unknown[];
  sourceTurnId: string;
  toolCallId: string;
  toolCallIndex: number;
  successfulToolResultIndex: number;
}): boolean {
  for (
    let messageIndex = params.toolCallIndex + 1;
    messageIndex < params.messages.length;
    messageIndex += 1
  ) {
    if (messageIndex === params.successfulToolResultIndex) {
      continue;
    }
    const message = params.messages[messageIndex];
    if (
      params.successfulToolResultIndex !== -1 &&
      messageIndex > params.successfulToolResultIndex &&
      messageIndex === params.messages.length - 1 &&
      isTerminalSilentAssistantMessage(message)
    ) {
      continue;
    }
    const mirror = readTerminalSourceReplyDeliveryMirror(message);
    if (mirror?.sourceTurnId === params.sourceTurnId && mirror.toolCallId === params.toolCallId) {
      continue;
    }
    // An empty provider abort is restart lifecycle noise. Partial output remains unsafe.
    if (isRestartAbortTailArtifact(message)) {
      continue;
    }
    return false;
  }
  return true;
}

type RecoveryCheckpointCompletion =
  | { outcome: "completed" }
  | { outcome: "changed" }
  | { outcome: "unsafe-transcript"; reason: string };

export async function markSessionCompletedAfterRecoveryCheckpoint(params: {
  agentId: string;
  entry: SessionEntry;
  messages: readonly unknown[];
  pendingFinalDeliveryIntentId?: string;
  reason: "delivered-terminal" | "delivered-terminal-receipt" | "handled-silent";
  storePath: string;
  sessionKey: string;
  sourceTurnId?: string;
  toolCallId?: string;
}): Promise<RecoveryCheckpointCompletion> {
  const expectedRecoveryRunId = normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId);
  const expectedRecoverySourceRunId = normalizeOptionalString(
    params.entry.restartRecoveryDeliverySourceRunId,
  );
  const endedAt = Date.now();
  const lifecyclePatch: SessionTranscriptTurnLifecyclePatch = {
    ...buildRestartRecoveryClaimCleanupPatch({
      entry: params.entry,
      recordTerminalSource: expectedRecoverySourceRunId !== undefined,
      terminalSourceRunId: expectedRecoverySourceRunId,
    }),
    abortedLastRun: false,
    lifecycleRunId: undefined,
    lastRunId: resolveRestartRecoveryTerminalClientRunId(params.entry),
    endedAt,
    pendingFinalDelivery: undefined,
    restartRecoveryForceSafeTools: undefined,
    restartRecoveryRuns: undefined,
    ...buildMainSessionRecoveryClearPatch(params.entry),
    runtimeMs:
      typeof params.entry.startedAt === "number"
        ? Math.max(0, endedAt - params.entry.startedAt)
        : undefined,
    status: "done",
    updatedAt: endedAt,
  };
  const sourceTurnId = normalizeOptionalString(params.sourceTurnId);
  if (params.reason === "handled-silent" && !sourceTurnId) {
    return {
      outcome: "unsafe-transcript",
      reason: "handled silent checkpoint lacks its durable source turn",
    };
  }
  const sourceTurnRange = sourceTurnId
    ? findSourceTurnRange({
        continuationRunId: expectedRecoveryRunId,
        messages: params.messages,
        sourceTurnId,
      })
    : undefined;
  const toolCallId = normalizeOptionalString(params.toolCallId);
  if (sourceTurnId && sourceTurnRange === undefined) {
    return {
      outcome: "unsafe-transcript",
      reason: "recovery checkpoint cannot be matched to its durable source turn",
    };
  }
  if (sourceTurnRange && sourceTurnRange.endIndex !== params.messages.length) {
    return {
      outcome: "unsafe-transcript",
      reason: "recovery checkpoint belongs to an earlier transcript turn",
    };
  }
  if (toolCallId) {
    if (!sourceTurnId || !sourceTurnRange) {
      return {
        outcome: "unsafe-transcript",
        reason: "terminal delivery lacks its durable source turn",
      };
    }
    const messageToolCallIndex = params.messages.findLastIndex(
      (message, index) =>
        index > sourceTurnRange.startIndex &&
        readAssistantToolCalls(message)?.some(
          (block) =>
            normalizeOptionalString(block.id) === toolCallId &&
            normalizeOptionalString(block.name) === "message",
        ),
    );
    if (messageToolCallIndex === -1) {
      return {
        outcome: "unsafe-transcript",
        reason: "terminal delivery cannot be matched to its message tool call",
      };
    }
    if (readAssistantToolCalls(params.messages[messageToolCallIndex])?.length !== 1) {
      return {
        outcome: "unsafe-transcript",
        reason: "terminal message tool call has sibling tool work",
      };
    }
    const successfulToolResultIndex = params.messages.findIndex(
      (message, index) =>
        index > messageToolCallIndex && isSuccessfulMessageToolResult(message, toolCallId),
    );
    if (
      !canReconcileTerminalDeliveryAtSourceTurnTail({
        messages: params.messages,
        sourceTurnId,
        toolCallId,
        toolCallIndex: messageToolCallIndex,
        successfulToolResultIndex,
      })
    ) {
      return {
        outcome: "unsafe-transcript",
        reason:
          successfulToolResultIndex === -1
            ? "terminal delivery would require an out-of-order transcript repair"
            : "terminal delivery result is followed by unfinished transcript work",
      };
    }
    if (successfulToolResultIndex === -1) {
      const persisted = await persistSessionTranscriptTurn(
        {
          agentId: params.agentId,
          sessionId: params.entry.sessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
        {
          expectedSessionId: params.entry.sessionId,
          expectedSessionState: buildRestartRecoveryExpectedState(params.entry),
          messages: [
            {
              idempotencyLookup: "scan",
              message: {
                role: "toolResult",
                toolCallId,
                toolName: "message",
                content: [{ type: "text", text: "Message delivered before gateway restart." }],
                idempotencyKey: `restart-recovery:message-tool-result:${sourceTurnId}:${toolCallId}`,
                isError: false,
                timestamp: endedAt,
              },
            },
          ],
          sessionLifecyclePatch: lifecyclePatch,
          updateMode: "none",
        },
      );
      const completed = persisted.sessionEntry?.status === "done";
      if (completed) {
        mainSessionRecoveryLog.info(
          `reconciled delivered terminal reply after restart: ${params.sessionKey}`,
        );
      }
      return { outcome: completed ? "completed" : "changed" };
    }
  }
  const marked = await applySessionEntryReplacements({
    agentId: params.agentId,
    sessionKeys: [params.sessionKey],
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((candidate) => candidate.sessionKey === params.sessionKey);
      const entry = current?.entry;
      if (
        !entry ||
        entry.sessionId !== params.entry.sessionId ||
        (params.pendingFinalDeliveryIntentId !== undefined &&
          entry.pendingFinalDelivery?.intentId !== params.pendingFinalDeliveryIntentId) ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !== expectedRecoveryRunId ||
        normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) !==
          expectedRecoverySourceRunId
      ) {
        return { result: false };
      }
      Object.assign(entry, lifecyclePatch);
      return {
        result: true,
        replacements: [{ sessionKey: params.sessionKey, entry }],
      };
    },
  });
  if (marked) {
    mainSessionRecoveryLog.info(
      params.reason === "delivered-terminal" || params.reason === "delivered-terminal-receipt"
        ? `reconciled delivered terminal reply after restart: ${params.sessionKey}`
        : `reconciled handled silent reply after restart: ${params.sessionKey}`,
    );
  }
  return { outcome: marked ? "completed" : "changed" };
}
