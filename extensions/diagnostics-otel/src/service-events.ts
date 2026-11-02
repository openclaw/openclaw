import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { formatError } from "./service-exporter.js";
import type { OtelLogger } from "./service-types.js";

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
  recorders: DiagnosticHandlers;
}) {
  const { logger, recorders } = params;
  return <K extends DiagnosticEventPayload["type"]>(
    evt: DiagnosticEvent<K>,
    metadata: DiagnosticEventMetadata,
    privateData: OtelDiagnosticEventPrivateData,
  ) => {
    try {
      if (Object.hasOwn(recorders, evt.type)) {
        recorders[evt.type]?.(evt, metadata, privateData);
      }
    } catch (err) {
      logger.error(`diagnostics-otel: event handler failed (${evt.type}): ${formatError(err)}`);
    }
  };
}
