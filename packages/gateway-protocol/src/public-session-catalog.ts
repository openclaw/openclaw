// Session catalog types exposed by the root gateway-protocol entrypoint.
export type {
  SessionCatalog,
  SessionCatalogCapabilities,
  SessionCatalogProfileRelation,
  SessionCatalogSourceProfileRelation,
  SessionCatalogDescriptor,
  SessionCatalogHost,
  SessionCatalogLocator,
  SessionCatalogPullRequestSummary,
  SessionCatalogSession,
  SessionCatalogShareRoute,
  SessionCatalogTranscriptItem,
  SessionsCatalogArchiveParams,
  SessionsCatalogArchiveResult,
  SessionsCatalogContinueParams,
  SessionsCatalogContinueResult,
  SessionsCatalogImportParams,
  SessionsCatalogImportResult,
  SessionsCatalogListParams,
  SessionsCatalogListResult,
  SessionsCatalogHostEvent,
  SessionCatalogRouteMethods,
  SessionsCatalogRouteParams,
  SessionsCatalogRouteResult,
  SessionsCatalogReadParams,
  SessionsCatalogReadResult,
  SessionsCatalogResolveResult,
  SessionsCatalogStartTerminalParams,
  SessionsCatalogStartTerminalResult,
} from "./schema/sessions-catalog.js";

/** Codex publishes epoch seconds; file-backed catalogs use epoch milliseconds. */
export function normalizeCatalogTimestamp(timestamp: number | undefined): number | undefined {
  return timestamp !== undefined && timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}
