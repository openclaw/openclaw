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
    "diagnostic.gc": recorders.recordGcDuration.bind(recorders),
    "gateway.event_loop.sample": recorders.recordGatewayEventLoopSample.bind(recorders),
    "gateway.rpc": recorders.recordGatewayRpc.bind(recorders),
    "model.usage": (evt, metadata, privateData) =>
      recorders.recordModelUsage(evt, metadata, privateData.hostPluginId),
    "webhook.received": recorders.recordWebhookReceived.bind(recorders),
    "webhook.processed": recorders.recordWebhookProcessed.bind(recorders),
    "webhook.error": recorders.recordWebhookError.bind(recorders),
    "message.queued": recorders.recordMessageQueued.bind(recorders),
    "message.received": recorders.recordMessageReceived.bind(recorders),
    "message.dispatch.started": recorders.recordMessageDispatchStarted.bind(recorders),
    "message.dispatch.completed": recorders.recordMessageDispatchCompleted.bind(recorders),
    "message.processed": recorders.recordMessageProcessed.bind(recorders),
    "message.delivery.started": recorders.recordMessageDeliveryStarted.bind(recorders),
    "message.delivery.completed": recorders.recordMessageDeliveryFinished.bind(recorders),
    "message.delivery.error": recorders.recordMessageDeliveryFinished.bind(recorders),
    "talk.event": recorders.recordTalkEvent.bind(recorders),
    "queue.lane.enqueue": recorders.recordLaneEnqueue.bind(recorders),
    "queue.lane.dequeue": recorders.recordLaneDequeue.bind(recorders),
    "session.state": recorders.recordSessionState.bind(recorders),
    "session.turn.created": recorders.recordSessionTurnCreated.bind(recorders),
    "session.stuck": recorders.recordSessionStuck.bind(recorders),
    "session.recovery.requested": recorders.recordSessionRecoveryRequested.bind(recorders),
    "session.recovery.completed": recorders.recordSessionRecoveryCompleted.bind(recorders),
    "run.attempt": recorders.recordRunAttempt.bind(recorders),
    "diagnostic.heartbeat": recorders.recordHeartbeat.bind(recorders),
    "diagnostic.liveness.warning": recorders.recordLivenessWarning.bind(recorders),
    "diagnostic.phase.completed": recorders.recordDiagnosticPhaseCompleted.bind(recorders),
    "run.started": recorders.recordRunStarted.bind(recorders),
    "run.completed": recorders.recordRunCompleted.bind(recorders),
    "harness.run.started": recorders.recordHarnessRunStarted.bind(recorders),
    "agent.commentary": recorders.recordAgentCommentary.bind(recorders),
    "harness.run.completed": recorders.recordHarnessRunFinished.bind(recorders),
    "harness.run.error": recorders.recordHarnessRunFinished.bind(recorders),
    "context.assembled": recorders.recordContextAssembled.bind(recorders),
    "model.call.started": recorders.recordModelCallStarted.bind(recorders),
    "model.call.completed": (evt, metadata, privateData) =>
      recorders.recordModelCallFinished(evt, metadata, privateData.modelContent),
    "model.call.error": (evt, metadata, privateData) =>
      recorders.recordModelCallFinished(evt, metadata, privateData.modelContent),
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
    "tool.loop": recorders.recordToolLoop.bind(recorders),
    "diagnostic.memory.sample": (evt) => recorders.recordMemoryUsageMetrics(evt),
    "diagnostic.memory.pressure": recorders.recordMemoryPressure.bind(recorders),
    "diagnostic.async_queue.dropped": recorders.recordAsyncQueueDropped.bind(recorders),
    "telemetry.exporter": recorders.recordTelemetryExporter.bind(recorders),
    "payload.large": recorders.recordPayloadLarge.bind(recorders),
    "model.failover": recorders.recordModelFailover.bind(recorders),
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
