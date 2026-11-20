import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { appendSessionTranscriptReport } from "../../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context-store.js";
import { buildAnnounceIdempotencyKey } from "../../announce-idempotency.js";
import { renderRuntimeCoordinationFailureCopy } from "../../failover/assistant-request-failure-copy.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { readSubagentRunAnnounceResult } from "../announce/subagent-announce-output.js";
import { resolveRequesterDeliveryOutcome } from "../registry/subagent-delivery-state.js";
import { subagentRegistryLog } from "../registry/subagent-registry-lifecycle-log.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { buildRequesterSettleWakeIdentity } from "../registry/subagent-requester-settle-identity.js";

/** Transcript custody prevents replay, but cannot substitute for a visible outcome. */
export async function settleConsumedRequesterDelivery(
  entries: readonly SubagentRunRecord[],
  outcome: SubagentAnnounceDeliveryResult,
): Promise<SubagentAnnounceDeliveryResult> {
  const settled = resolveRequesterDeliveryOutcome(entries, outcome)!;
  const required = entries.filter((entry) => entry.expectsCompletionMessage === true);
  if (settled !== outcome && required[0]) {
    await recordRequiredCompletionNotice(
      required[0],
      outcome.error ?? outcome.reason ?? "Requester did not produce a visible reply",
      required,
      "result",
    );
  }
  return settled;
}

export async function recordRequiredCompletionNotice(
  entry: SubagentRunRecord,
  reason: string,
  batch: readonly SubagentRunRecord[] = [entry],
  kind: "failed" | "delayed" | "result" = "failed",
): Promise<void> {
  const wake = entry.requesterSettleWake;
  if (
    kind !== "result" &&
    subagentRuns.get(entry.runId)?.delivery?.status === "delivered" &&
    (kind === "delayed" || !wake?.requesterYieldBatch)
  ) {
    return;
  }
  subagentRegistryLog.warn(`Subagent completion delivery ${kind}`, {
    runId: entry.runId,
    requesterSessionKey: entry.requesterSessionKey,
    reason,
  });
  if (
    entry.expectsCompletionMessage !== true ||
    entry.execution.status !== "terminal" ||
    entry.pauseReason === "sessions_yield"
  ) {
    return;
  }
  // Share the yielded requester's failure identity with its lifecycle settlement.
  const runId =
    wake?.requesterYieldBatch || batch.length > 1
      ? (wake?.requesterRunId ??
        buildAnnounceIdempotencyKey(
          `${
            buildRequesterSettleWakeIdentity({
              requesterSessionKey: entry.requesterSessionKey,
              requesterAgentId: entry.requesterAgentId,
              batchRunIds: wake?.batchRunIds ?? batch.map((member) => member.runId),
              rearmGeneration: wake?.rearmGeneration,
            }).batchKey
          }:delivery-failure`,
        ))
      : `subagent-delivery-failure:${entry.taskRunId ?? entry.runId}:${entry.delivery?.generation ?? 1}`;
  // Report delivery state without borrowing its retired execution authority.
  // Address the current chat, including a compaction successor; deletion and Stop get no notice.
  const requester = {
    agentId: entry.requesterAgentId,
    sessionKey: entry.requesterSessionKey,
    storePath: entry.requesterStorePath,
  };
  const current = await readSessionEntryReadOnlyInWorker(requester);
  if (!current?.sessionId || current.status === "killed") {
    return;
  }
  const customType =
    kind === "delayed"
      ? "subagent-delivery-delayed"
      : kind === "result"
        ? "subagent-completion"
        : "run-failed-before-reply";
  const findings = (
    await Promise.all(
      batch.map(async (child) => {
        const outcome = child.execution.outcome;
        return [
          `Child ${child.childSessionKey} (run ${child.runId})`,
          outcome?.status === "error"
            ? outcome.error === "Gateway stopped"
              ? "Interrupted by Gateway restart; not resumed."
              : outcome.error
            : outcome?.status,
          kind === "result" ? (await readSubagentRunAnnounceResult(child)).text : undefined,
        ]
          .filter(Boolean)
          .join("\n\n");
      }),
    )
  ).join("\n\n");
  const result = await runWithoutOwnedSessionTranscriptWrites(() =>
    appendSessionTranscriptReport(
      {
        ...requester,
        sessionId: current.sessionId,
        expectedLifecycleRevision: current.lifecycleRevision,
      },
      {
        kind: "custom",
        customTypes: [customType],
        selectReport: (latest) =>
          isRecord(latest?.details) && latest.details.runId === runId
            ? undefined
            : {
                customType,
                display: true,
                excludeFromContext:
                  kind !== "failed" ||
                  batch.every((child) => child.delivery?.requesterDelivery?.state === "consumed"),
                content:
                  kind === "delayed"
                    ? "Automatic delivery of a child result timed out. The result is still saved and may still arrive automatically."
                    : kind === "result"
                      ? findings
                      : `${expectDefined(
                          renderRuntimeCoordinationFailureCopy("child_completion_delivery_failed"),
                          "child completion failure notice",
                        )}\n\n${findings}`,
                details: { runId, childRunId: entry.runId, error: reason },
              },
      },
    ),
  );
  if (!result.ok) {
    throw new Error(`Child result failure notice could not be appended: ${result.error.code}`);
  }
}
