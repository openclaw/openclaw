import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { formatError } from "./service-exporter.js";
import type { createDiagnosticsLogExporter } from "./service-logs.js";
import type { createHarnessRecorders } from "./service-recorders-harness.js";
import type { createModelRecorders } from "./service-recorders-model.js";
import type { createOperationsRecorders } from "./service-recorders-operations.js";
import type { createToolAndSystemRecorders } from "./service-recorders-tools.js";
import type { createUsageRecorders } from "./service-recorders-usage.js";
import type { OtelLogger } from "./service-types.js";

type DiagnosticsEventRecorders = ReturnType<typeof createHarnessRecorders> &
  ReturnType<typeof createModelRecorders> &
  ReturnType<typeof createOperationsRecorders> &
  ReturnType<typeof createToolAndSystemRecorders> &
  ReturnType<typeof createUsageRecorders>;
type OtelDiagnosticEventPrivateData = DiagnosticEventPrivateData &
  Readonly<{
    hostPluginId?: string;
  }>;

type DiagnosticEvent<K extends DiagnosticEventPayload["type"]> = {
  [Type in K]: Extract<DiagnosticEventPayload, { type: Type }>;
}[K];
type DiagnosticHandlers = {
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
    "diagnostic.gc": recorders.recordGcDuration,
    "gateway.event_loop.sample": recorders.recordGatewayEventLoopSample,
    "gateway.rpc": recorders.recordGatewayRpc,
    "model.usage": (evt, metadata, privateData) =>
      recorders.recordModelUsage(evt, metadata, privateData.hostPluginId),
    "webhook.received": recorders.recordWebhookReceived,
    "webhook.processed": recorders.recordWebhookProcessed,
    "webhook.error": recorders.recordWebhookError,
    "message.queued": recorders.recordMessageQueued,
    "message.received": recorders.recordMessageReceived,
    "message.dispatch.started": recorders.recordMessageDispatchStarted,
    "message.dispatch.completed": recorders.recordMessageDispatchCompleted,
    "message.processed": recorders.recordMessageProcessed,
    "message.delivery.started": recorders.recordMessageDeliveryStarted,
    "message.delivery.completed": recorders.recordMessageDeliveryFinished,
    "message.delivery.error": recorders.recordMessageDeliveryFinished,
    "talk.event": recorders.recordTalkEvent,
    "queue.lane.enqueue": recorders.recordLaneEnqueue,
    "queue.lane.dequeue": recorders.recordLaneDequeue,
    "session.state": recorders.recordSessionState,
    "session.turn.created": recorders.recordSessionTurnCreated,
    "session.stuck": recorders.recordSessionStuck,
    "session.recovery.requested": recorders.recordSessionRecoveryRequested,
    "session.recovery.completed": recorders.recordSessionRecoveryCompleted,
    "run.attempt": recorders.recordRunAttempt,
    "diagnostic.heartbeat": recorders.recordHeartbeat,
    "diagnostic.liveness.warning": recorders.recordLivenessWarning,
    "diagnostic.phase.completed": recorders.recordDiagnosticPhaseCompleted,
    "run.started": recorders.recordRunStarted,
    "run.completed": recorders.recordRunCompleted,
    "harness.run.started": recorders.recordHarnessRunStarted,
    "agent.commentary": recorders.recordAgentCommentary,
    "harness.run.completed": recorders.recordHarnessRunFinished,
    "harness.run.error": recorders.recordHarnessRunFinished,
    "context.assembled": recorders.recordContextAssembled,
    "model.call.started": recorders.recordModelCallStarted,
    "model.call.completed": (evt, metadata, privateData) =>
      recorders.recordModelCallFinished(evt, metadata, privateData.modelContent),
    "model.call.error": (evt, metadata, privateData) =>
      recorders.recordModelCallFinished(evt, metadata, privateData.modelContent),
    "tool.execution.started": recorders.recordToolExecutionStarted,
    "tool.execution.completed": (evt, metadata, privateData) =>
      recorders.recordToolExecutionFinished(evt, metadata, privateData.toolContent),
    "tool.execution.error": (evt, metadata, privateData) =>
      recorders.recordToolExecutionFinished(evt, metadata, privateData.toolContent),
    "tool.execution.blocked": recorders.recordToolExecutionBlocked,
    "skill.used": recorders.recordSkillUsed,
    "exec.process.completed": recorders.recordExecProcessCompleted,
    "log.record": (evt, metadata) => recordLogEvent?.(evt, metadata),
    "security.event": (evt, metadata) => recordLogEvent?.(evt, metadata),
    "tool.loop": recorders.recordToolLoop,
    "diagnostic.memory.sample": (evt) => recorders.recordMemoryUsageMetrics(evt),
    "diagnostic.memory.pressure": recorders.recordMemoryPressure,
    "diagnostic.async_queue.dropped": recorders.recordAsyncQueueDropped,
    "telemetry.exporter": recorders.recordTelemetryExporter,
    "payload.large": recorders.recordPayloadLarge,
    "model.failover": recorders.recordModelFailover,
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
