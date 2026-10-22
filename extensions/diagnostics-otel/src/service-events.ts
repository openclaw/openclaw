import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { formatError } from "./service-exporter.js";
import type { createDiagnosticsLogExporter } from "./service-logs.js";
import type { OtelLogger } from "./service-types.js";

type DiagnosticsEventRecorders = {
  operations: DiagnosticHandlers;
  harness: DiagnosticHandlers;
  usage: DiagnosticHandlers;
  model: DiagnosticHandlers;
  tools: DiagnosticHandlers;
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
    ...recorders.model,
    ...recorders.tools,
    "log.record": (evt, metadata) => recordLogEvent?.(evt, metadata),
    "security.event": (evt, metadata) => recordLogEvent?.(evt, metadata),
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
