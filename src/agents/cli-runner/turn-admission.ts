import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import { hasInternalDiagnosticEventListeners } from "../../infra/diagnostic-event-listener-presence.js";
import { areDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  createDiagnosticEmbeddedRunOwner,
  closeDiagnosticEmbeddedRunOwner,
} from "../../logging/diagnostic-run-activity.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  assertSessionControllerOperation,
  markReplyOperationExecutionStarted,
} from "../../sessions/session-controller.state.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import {
  withGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { isClaudeCliBackend } from "./cli-run-settlement.js";
import {
  runClaudeCliAgentTurnWithDiagnostics,
  type ClaudeCliRunDiagnosticLifecycle,
} from "./run-diagnostics.js";
import type { RunCliAgentParams } from "./types.js";

/** Prepares and runs one CLI-backed agent turn. */
export function runWithCliTurn(
  paramsInput: RunCliAgentParams,
  run: (
    params: RunCliAgentParams,
    diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle,
  ) => Promise<EmbeddedAgentRunResult>,
): Promise<EmbeddedAgentRunResult> {
  const lifecycleGeneration =
    paramsInput.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(paramsInput.runId);
  const suppliedKey = paramsInput.sessionTarget?.sessionKey ?? paramsInput.sessionKey;
  const sessionOwner = normalizeAgentId(
    parseAgentSessionKey(suppliedKey)?.agentId ||
      paramsInput.sessionTarget?.agentId ||
      paramsInput.agentId ||
      LEGACY_IMPLICIT_AGENT_ID,
  );
  const params = {
    ...paramsInput,
    sessionId: paramsInput.sessionTarget?.sessionId ?? paramsInput.sessionId,
    sessionKey:
      suppliedKey && paramsInput.config
        ? canonicalizeMainSessionAlias({
            cfg: paramsInput.config,
            agentId: sessionOwner,
            sessionKey: suppliedKey.trim(),
          })
        : suppliedKey,
    lifecycleGeneration,
  };
  return withSessionTurn(
    {
      ...params,
      agentId: sessionOwner,
      storePath:
        params.sessionTarget?.storePath ??
        params.storePath ??
        (params.config
          ? resolveSessionStorePathCore(params.config.session?.store, { agentId: sessionOwner })
          : undefined),
      detached: Boolean(
        params.isolatedCompletion ||
        (params.sessionManager && !params.sessionManager.getSessionTarget()),
      ),
    },
    async (operation, signal) => {
      const diagnosticOwner =
        params.diagnosticOwner ??
        createDiagnosticEmbeddedRunOwner({
          ...params,
          watchdogAttempt: operation
            ? operation.watchdog.attachAttempt({
                assertCurrent: () => {
                  signal.throwIfAborted();
                  assertSessionControllerOperation(operation);
                  params.assertCurrent?.();
                },
              })
            : undefined,
        });
      const ownedDiagnostics = diagnosticOwner !== params.diagnosticOwner;
      const admittedParams = {
        ...params,
        diagnosticOwner,
        replyOperation: operation,
        abortSignal: signal,
      };
      if (operation) {
        markReplyOperationExecutionStarted(operation);
        if (operation.phase === "queued") {
          operation.setPhase("running");
        }
      }
      const caller = getGatewayToolCallerIdentity();
      try {
        return await withGatewayToolCallerIdentity(
          caller && { ...caller, watchdogAttempt: diagnosticOwner.watchdogAttempt },
          () =>
            withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
              // Listener presence is process-stable; disabled installs skip synthetic traces.
              isClaudeCliBackend(params.provider) &&
              areDiagnosticsEnabledForProcess() &&
              hasInternalDiagnosticEventListeners()
                ? runClaudeCliAgentTurnWithDiagnostics(admittedParams, (diagnosticLifecycle) =>
                    run(admittedParams, diagnosticLifecycle),
                  )
                : run(admittedParams),
            ),
        );
      } finally {
        if (ownedDiagnostics) {
          closeDiagnosticEmbeddedRunOwner(diagnosticOwner);
        }
      }
    },
  );
}
