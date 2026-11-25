export type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
export { isInternalDiagnosticEventMetadata } from "openclaw/plugin-sdk/diagnostic-runtime";
export {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type OpenClawPluginHttpRouteHandler,
  type OpenClawPluginService,
  type OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
export { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

type PluginMetricsListener = Parameters<
  NonNullable<
    NonNullable<
      import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginServiceContext["internalDiagnostics"]
    >["onPluginMetrics"]
  >
>[0];
/** Host-admitted plugin metric family delivered through `internalDiagnostics.onPluginMetrics`. */
export type PluginMetricFamily = Parameters<PluginMetricsListener["record"]>[0];
