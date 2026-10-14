import { createHash } from "node:crypto";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActiveAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { captureAgentRunTerminalPersistence } from "../../infra/agent-run-terminal-writes.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { MODEL_FALLBACK_NOTICE_KIND } from "../../shared/model-fallback-notice.js";
import { FAILOVER_REASONS } from "../failover/signal.js";
import type { ModelFallbackStepFields } from "../model-fallback-observation.js";
import type { EmbeddedAgentRunEntryParams } from "./run-entry.types.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const log = createSubsystemLogger("model-fallback");

/** Completion, rather than retry admission, owns evidence that the primary recovered. */
export async function persistModelFallbackRestoredTranscriptNotice(params: {
  agentId?: string;
  sessionKey: string;
  storePath: string;
  entry: InternalSessionEntry;
  config: OpenClawConfig;
  runId: string;
  fromModel: string;
  toModel: string;
  assertCurrent: () => void;
}): Promise<boolean> {
  const { runId, fromModel, toModel, entry } = params;
  if (
    !runId ||
    runId.length > 4096 ||
    !fromModel ||
    fromModel.length > 512 ||
    !toModel ||
    toModel.length > 512 ||
    fromModel === toModel
  ) {
    return false;
  }
  try {
    params.assertCurrent();
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.js");
    params.assertCurrent();
    const transition = createHash("sha256").update(runId).digest("hex");
    const result = await appendAssistantMessageToSessionTranscript({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      expectedSessionId: entry.sessionId,
      expectedLifecycleRevision: entry.lifecycleRevision ?? null,
      expectedWriterRunId: entry.activeWriterRunId,
      runId,
      config: params.config,
      assertCurrent: params.assertCurrent,
      idempotencyKey: `model-fallback-restored:${transition}`,
      text: `Selected model ${toModel} restored (was ${fromModel}).`,
      deliveryMirror: {
        kind: MODEL_FALLBACK_NOTICE_KIND,
        phase: "restored",
        runId,
        fromModel,
        toModel,
      },
    });
    if (result.ok) {
      return true;
    }
    if (result.code !== "session-rebound") {
      log.warn("Model restoration transcript notice was not persisted.");
    }
  } catch {
    // Keep the successful reply usable; retain fallback state so a later success can record it.
    log.warn("Model restoration transcript notice was not persisted.");
  }
  return false;
}

/** Record an operational fact through the existing run owner, never a provider input. */
export async function persistModelFallbackTranscriptNotice(
  params: EmbeddedAgentRunEntryParams<EmbeddedAgentRunResult>,
  step: ModelFallbackStepFields,
  assertRunCurrent: () => void,
): Promise<void> {
  const { identity, preparedRunAdmission } = params;
  const sessionKey = identity.sessionKey?.trim();
  const sessionLifecycleRevision = identity.sessionLifecycleRevision;
  const fromModel = step.fallbackStepFromModel;
  const toModel = step.fallbackStepToModel;
  if (
    params.behavior.kind === "maintenance" ||
    step.fallbackStepFinalOutcome !== "next_fallback" ||
    !sessionKey ||
    !identity.sessionId ||
    sessionLifecycleRevision === undefined ||
    !identity.runId ||
    identity.runId.length > 4096 ||
    !fromModel ||
    fromModel.length > 512 ||
    !toModel ||
    toModel.length > 512 ||
    fromModel === toModel ||
    !preparedRunAdmission ||
    preparedRunAdmission.operationalRunInstance.runId !== identity.runId ||
    !getActiveAgentRunDelegatedAuthority(preparedRunAdmission.operationalRunInstance)
  ) {
    return;
  }
  const { writeContext } = captureAgentRunTerminalPersistence(identity.runId);
  if (!writeContext) {
    return;
  }
  const assertCurrent = composeSessionSourceAssertion(
    [preparedRunAdmission.assertSourceCurrent, writeContext.assertCurrent],
    (assertSource) => {
      assertRunCurrent();
      assertSource();
    },
  );
  try {
    assertCurrent();
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.js");
    assertCurrent();
    const reason = FAILOVER_REASONS.find((value) => value === step.fallbackStepFromFailureReason);
    const transition = createHash("sha256")
      .update(JSON.stringify([identity.runId, step.fallbackStepChainPosition, fromModel, toModel]))
      .digest("hex");
    const result = await writeContext.run(() =>
      appendAssistantMessageToSessionTranscript({
        agentId: identity.agentId,
        sessionKey,
        expectedSessionId: identity.sessionId,
        expectedLifecycleRevision: sessionLifecycleRevision,
        expectedWriterRunId: identity.runId,
        runId: identity.runId,
        config: params.selection.cfg,
        assertCurrent,
        idempotencyKey: `model-fallback:${transition}`,
        text: `Model switched from ${fromModel} to ${toModel}${reason ? ` (${reason})` : ""}.`,
        deliveryMirror: {
          kind: MODEL_FALLBACK_NOTICE_KIND,
          runId: identity.runId,
          fromModel,
          toModel,
          ...(reason ? { reason } : {}),
        },
      }),
    );
    if (!result.ok && result.code !== "session-rebound") {
      log.warn("Model fallback transcript notice was not persisted.");
    }
  } catch {
    // The fallback remains usable when storage fails or its original source closes.
    // Do not include raw provider diagnostics in this operational notice or warning.
    log.warn("Model fallback transcript notice was not persisted.");
  }
}
