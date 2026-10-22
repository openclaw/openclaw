import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { formatError } from "./service-exporter.js";
import type { createDiagnosticsLogExporter } from "./service-logs.js";
import type { createModelRecorders } from "./service-recorders-model.js";
import type { createToolAndSystemRecorders } from "./service-recorders-tools.js";
import type { OtelLogger } from "./service-types.js";

type DiagnosticsEventRecorders = ReturnType<typeof createModelRecorders> &
  ReturnType<typeof createToolAndSystemRecorders> & {
    operations: DiagnosticHandlers;
    harness: DiagnosticHandlers;
    usage: DiagnosticHandlers;
  };
type OtelDiagnosticEventPrivateData = DiagnosticEventPrivateData &
  Readonly<{
    hostPluginId?: string;
  }>;

type DiagnosticEvent<K extends DiagnosticEventPayload["type"]> = {
  [Type in K]: Extract<DiagnosticEventPayload, { type: Type }>;
}[K];
export type DiagnosticHandlers = {
  [Type in DiagnosticEventPayload["type"]]?: (
    evt: DiagnosticEvent<Type>,
    metadata: DiagnosticEventMetadata,
    privateData: OtelDiagnosticEventPrivateData,
  ) => unknown;
};

export function createDiagnosticsEventHandler(params: {
  logger: OtelLogger;
  recorders: DiagnosticsEventRecorders;
  recordLogEvent: ReturnType<typeof createDiagnosticsLogExporter>["recordLogEvent"];
}) {
  const { logger, recorders, recordLogEvent } = params;
  const handlers: DiagnosticHandlers = {
    ...recorders.operations,
    ...recorders.harness,
    ...recorders.usage,
    "diagnostic.gc": recorders.recordGcDuration.bind(recorders),
    "gateway.event_loop.sample": recorders.recordGatewayEventLoopSample.bind(recorders),
    "diagnostic.heartbeat": recorders.recordHeartbeat.bind(recorders),
    "diagnostic.liveness.warning": recorders.recordLivenessWarning.bind(recorders),
    "diagnostic.phase.completed": recorders.recordDiagnosticPhaseCompleted.bind(recorders),
    "model.call.started": recorders.recordModelCallStarted.bind(recorders),
    "model.call.completed": (evt, metadata, privateData) =>
      recorders.recordModelCallFinished(evt, metadata, privateData.modelContent),
    "model.call.error": (evt, metadata, privateData) =>
      recorders.recordModelCallFinished(evt, metadata, privateData.modelContent),
    "model.response.observed": recorders.recordModelResponseObserved.bind(recorders),
    "tool.execution.started": recorders.recordToolExecutionStarted.bind(recorders),
    "tool.execution.completed": (evt, metadata, privateData) =>
      recorders.recordToolExecutionFinished(evt, metadata, privateData.toolContent),
    "tool.execution.error": (evt, metadata, privateData) =>
      recorders.recordToolExecutionFinished(evt, metadata, privateData.toolContent),
    "tool.execution.blocked": recorders.recordToolExecutionBlocked.bind(recorders),
    "skill.used": recorders.recordSkillUsed.bind(recorders),
    "exec.process.completed": recorders.recordExecProcessCompleted.bind(recorders),
    "log.record": (evt, metadata) => recordLogEvent?.(evt, metadata),
    "security.event": (evt, metadata) => recordLogEvent?.(evt, metadata),
    "telemetry.exporter": recorders.recordTelemetryExporter.bind(recorders),
    "payload.large": recorders.recordPayloadLarge.bind(recorders),
  };
  return <K extends DiagnosticEventPayload["type"]>(
    evt: DiagnosticEvent<K>,
    metadata: DiagnosticEventMetadata,
    privateData: OtelDiagnosticEventPrivateData,
  ) => {
    try {
      if (Object.hasOwn(handlers, evt.type)) {
        handlers[evt.type]?.(evt, metadata, privateData);
      }
    } catch (err) {
      logger.error(`diagnostics-otel: event handler failed (${evt.type}): ${formatError(err)}`);
    }
  };
}
