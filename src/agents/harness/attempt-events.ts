import { projectChatErrorDetail } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
} from "../embedded-agent-error-observation.js";
import { renderUserFacingText } from "../embedded-agent-helpers/user-facing-text.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { classifyFailoverReason } from "../failover/classify.js";

/** Observer failures cannot interrupt the authoritative native attempt. */
export async function emitAgentHarnessAttemptEvent(
  attempt: Pick<EmbeddedRunAttemptParams, "runId" | "sessionKey" | "onAgentEvent">,
  event: AgentHarnessAttemptEvent,
  diagnostics: {
    label: string;
    log: { debug: (message: string, details: { error: unknown }) => void };
  },
): Promise<void> {
  try {
    emitAgentEvent({
      runId: attempt.runId,
      stream: event.stream,
      data: event.data,
      ...(attempt.sessionKey ? { sessionKey: attempt.sessionKey } : {}),
    });
  } catch (error) {
    diagnostics.log.debug(`${diagnostics.label} global agent event emit failed`, { error });
  }
  try {
    await attempt.onAgentEvent?.(event);
  } catch (error) {
    diagnostics.log.debug(`${diagnostics.label} agent event handler threw`, { error });
  }
}

/** Share event bookkeeping while the backend decides whether a native handoff suppresses it. */
export function createAgentHarnessAttemptLifecycle(params: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "provider" | "modelId" | "onExecutionPhase" | "deferTerminalLifecycle"
  >;
  backend: string;
  startedAtMs: number;
  state: { lifecycleStarted: boolean; lifecycleTerminalEmitted: boolean };
  emitEvent: (event: AgentHarnessAttemptEvent) => Promise<void>;
  shouldSuppressTerminal?: () => boolean;
}) {
  const emitLifecycleStart = (model: { provider: string; model: string }) => {
    void params.emitEvent({
      stream: "lifecycle",
      data: { phase: "start", startedAt: params.startedAtMs },
    });
    void params.emitEvent({ stream: "lifecycle", data: { phase: "model", ...model } });
    params.state.lifecycleStarted = true;
  };
  const emitLifecycleTerminal = (data: Record<string, unknown> & { phase: "end" | "error" }) => {
    if (
      !params.state.lifecycleStarted ||
      params.state.lifecycleTerminalEmitted ||
      params.shouldSuppressTerminal?.()
    ) {
      return;
    }
    let terminalData = data;
    if (data.error) {
      const { provider, modelId: model } = params.attempt;
      const rawError = formatErrorMessage(data.error);
      const observed = buildApiErrorObservationFields(rawError, { provider });
      terminalData = {
        ...terminalData,
        error: buildTextObservationFields(renderUserFacingText(rawError, { errorContext: true }), {
          provider,
        }).textPreview,
        errorObservation: projectChatErrorDetail({
          ...observed,
          provider,
          model,
          failoverReason: classifyFailoverReason(rawError, { provider }),
          httpStatus: observed.httpCode ? Number(observed.httpCode) : undefined,
        }),
      };
    }
    void params.emitEvent({
      stream: "lifecycle",
      data: {
        startedAt: params.startedAtMs,
        endedAt: Date.now(),
        ...terminalData,
        ...(params.attempt.deferTerminalLifecycle ? { phase: "finishing" } : {}),
      },
    });
    params.state.lifecycleTerminalEmitted = true;
  };
  const executionPhaseKeys = new Set<string>();
  const emitExecutionPhaseOnce = (key: string, info: AgentHarnessAttemptExecutionPhase) => {
    if (executionPhaseKeys.has(key)) {
      return;
    }
    executionPhaseKeys.add(key);
    params.attempt.onExecutionPhase?.({
      provider: params.attempt.provider,
      model: params.attempt.modelId,
      backend: params.backend,
      ...info,
    });
  };
  return { emitLifecycleStart, emitLifecycleTerminal, emitExecutionPhaseOnce };
}

type AgentHarnessAttemptEvent = Parameters<
  NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>
>[0];
type AgentHarnessAttemptExecutionPhase = Parameters<
  NonNullable<EmbeddedRunAttemptParams["onExecutionPhase"]>
>[0];
