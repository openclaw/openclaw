import { createHash } from "node:crypto";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { getActiveAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { captureAgentRunTerminalPersistence } from "../../infra/agent-run-terminal-writes.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { MODEL_FALLBACK_NOTICE_KIND } from "../../shared/model-fallback-notice.js";
import { FAILOVER_REASONS } from "../failover/signal.js";
import type { ModelFallbackStepFields } from "../model-fallback-observation.js";
import type { EmbeddedAgentRunEntryParams } from "./run-entry.types.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const log = createSubsystemLogger("model-fallback");

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
