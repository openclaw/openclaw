// Tokenomics API module exposes the plugin public contract.
export type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
export { isInternalDiagnosticEventMetadata } from "openclaw/plugin-sdk/diagnostic-runtime";
export {
  type OpenClawPluginApi,
  type OpenClawPluginHttpRouteHandler,
  type OpenClawPluginService,
  type OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";

// FinOps observability surface — served at the report route via `?view=finops`
// and re-exported here for external tools/consumers. Read-only, non-enforcing.
export {
  buildFinOpsReport,
  cacheSavingsByModel,
  cheapestEquivalentAdvisor,
  forecastBurn,
  realizedRateByModel,
  spendByDimension,
} from "./src/finops.js";
export type {
  AdvisorRow,
  BurnForecast,
  CacheSavingsRow,
  FinOpsReport,
  FinOpsTags,
  ModelRealized,
  SpendGroup,
  TaggedLedgerEntry,
} from "./src/finops.js";
