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

export function createDiagnosticsEventHandler(params: {
  logger: OtelLogger;
  recorders: DiagnosticsEventRecorders;
  recordLogRecord: ReturnType<typeof createDiagnosticsLogExporter>["recordLogRecord"];
  recordSecurityEvent: ReturnType<typeof createDiagnosticsLogExporter>["recordSecurityEvent"];
}) {
  const { logger, recorders, recordLogRecord, recordSecurityEvent } = params;
  return (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
    privateData: OtelDiagnosticEventPrivateData,
  ) => {
    try {
      switch (evt.type) {
        case "diagnostic.child_process.spawn":
          // Child-launch counts currently export through Prometheus.
          return;
        case "diagnostic.gc":
          return recorders.recordGcDuration(evt, metadata);
        case "gateway.event_loop.sample":
          return recorders.recordGatewayEventLoopSample(evt, metadata);
        case "gateway.rpc":
          return recorders.recordGatewayRpc(evt, metadata);
        case "model.usage":
          return recorders.recordModelUsage(evt, metadata, privateData.hostPluginId);
        case "webhook.received":
          return recorders.recordWebhookReceived(evt);
        case "webhook.processed":
          return recorders.recordWebhookProcessed(evt);
        case "webhook.error":
          return recorders.recordWebhookError(evt);
        case "message.queued":
          return recorders.recordMessageQueued(evt);
        case "message.received":
          return recorders.recordMessageReceived(evt);
        case "message.dispatch.started":
          return recorders.recordMessageDispatchStarted(evt, metadata);
        case "message.dispatch.completed":
          return recorders.recordMessageDispatchCompleted(evt);
        case "message.processed":
          return recorders.recordMessageProcessed(evt, metadata);
        case "message.delivery.started":
          return recorders.recordMessageDeliveryStarted(evt);
        case "message.delivery.completed":
          return recorders.recordMessageDeliveryCompleted(evt, metadata);
        case "message.delivery.error":
          return recorders.recordMessageDeliveryError(evt, metadata);
        case "talk.event":
          return recorders.recordTalkEvent(evt, metadata);
        case "queue.lane.enqueue":
          return recorders.recordLaneEnqueue(evt);
        case "queue.lane.dequeue":
          return recorders.recordLaneDequeue(evt);
        case "session.state":
          return recorders.recordSessionState(evt);
        case "session.long_running":
        case "session.stalled":
          break;
        case "session.turn.created":
          return recorders.recordSessionTurnCreated(evt);
        case "session.stuck":
          return recorders.recordSessionStuck(evt);
        case "session.recovery.requested":
          return recorders.recordSessionRecoveryRequested(evt);
        case "session.recovery.completed":
          return recorders.recordSessionRecoveryCompleted(evt);
        case "run.attempt":
          return recorders.recordRunAttempt(evt);
        case "run.progress":
          break;
        case "run.execution_phase":
          break;
        case "diagnostic.heartbeat":
          return recorders.recordHeartbeat(evt);
        case "diagnostic.liveness.warning":
          return recorders.recordLivenessWarning(evt);
        case "diagnostic.phase.completed":
          return recorders.recordDiagnosticPhaseCompleted(evt, metadata);
        case "run.started":
          return recorders.recordRunStarted(evt, metadata);
        case "run.completed":
          return recorders.recordRunCompleted(evt, metadata, privateData);
        case "harness.run.started":
          return recorders.recordHarnessRunStarted(evt, metadata);
        case "agent.commentary":
          return recorders.recordAgentCommentary(evt, metadata, privateData);
        case "harness.run.completed":
        case "harness.run.error":
          return recorders.recordHarnessRunFinished(evt, metadata, privateData);
        case "context.assembled":
          return recorders.recordContextAssembled(evt, metadata);
        case "model.call.started":
          recorders.recordModelCallStarted(evt, metadata);
          return;
        case "model.call.completed":
        case "model.call.error":
          return recorders.recordModelCallFinished(evt, metadata, privateData.modelContent);
        case "tool.execution.started":
          recorders.recordToolExecutionStarted(evt, metadata);
          return;
        case "tool.execution.completed":
        case "tool.execution.error":
          return recorders.recordToolExecutionFinished(evt, metadata, privateData.toolContent);
        case "tool.execution.blocked":
          return recorders.recordToolExecutionBlocked(evt, metadata);
        case "skill.used":
          return recorders.recordSkillUsed(evt, metadata);
        case "exec.process.completed":
          return recorders.recordExecProcessCompleted(evt, metadata);
        case "exec.approval.followup_suppressed":
          break;
        case "log.record":
          return recordLogRecord?.(evt, metadata);
        case "security.event":
          return recordSecurityEvent?.(evt, metadata);
        case "tool.loop":
          return recorders.recordToolLoop(evt);
        case "diagnostic.memory.sample":
          return recorders.recordMemorySample(evt);
        case "diagnostic.memory.pressure":
          return recorders.recordMemoryPressure(evt);
        case "diagnostic.async_queue.dropped":
          return recorders.recordAsyncQueueDropped(evt);
        case "telemetry.exporter":
          return recorders.recordTelemetryExporter(evt, metadata);
        case "payload.large":
          return recorders.recordPayloadLarge(evt);
        case "model.failover":
          return recorders.recordModelFailover(evt, metadata);
      }
    } catch (err) {
      logger.error(`diagnostics-otel: event handler failed (${evt.type}): ${formatError(err)}`);
    }
  };
}
