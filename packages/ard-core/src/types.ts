// Shared Agent Resource Discovery contracts used by catalog and registry code.

export const ARD_SPEC_VERSION = "1.0" as const;

export const ARD_CATALOG_WELL_KNOWN_PATH = "/.well-known/ai-catalog.json" as const;

export const ARD_MEDIA_TYPE_AI_CATALOG = "application/ai-catalog+json" as const;
export const ARD_MEDIA_TYPE_AI_REGISTRY = "application/ai-registry+json" as const;
export const ARD_MEDIA_TYPE_A2A_AGENT_CARD = "application/a2a-agent-card+json" as const;
export const ARD_MEDIA_TYPE_MCP_SERVER_CARD = "application/mcp-server-card+json" as const;
export const ARD_MEDIA_TYPE_MCP_SERVER_LEGACY = "application/mcp-server+json" as const;
export const ARD_MEDIA_TYPE_OPENCLAW_PLUGIN = "application/vnd.openclaw.plugin+json" as const;
export const ARD_MEDIA_TYPE_OPENCLAW_TOOL_GROUP =
  "application/vnd.openclaw.tool-group+json" as const;

export const STANDARD_ARD_MEDIA_TYPES = [
  ARD_MEDIA_TYPE_A2A_AGENT_CARD,
  ARD_MEDIA_TYPE_AI_CATALOG,
  ARD_MEDIA_TYPE_AI_REGISTRY,
  ARD_MEDIA_TYPE_MCP_SERVER_CARD,
] as const;

export const SUPPORTED_ARD_MCP_MEDIA_TYPES = [
  ARD_MEDIA_TYPE_MCP_SERVER_CARD,
  ARD_MEDIA_TYPE_MCP_SERVER_LEGACY,
] as const;

export type StandardArdMediaType = (typeof STANDARD_ARD_MEDIA_TYPES)[number];

export type SupportedArdMcpMediaType = (typeof SUPPORTED_ARD_MCP_MEDIA_TYPES)[number];

export type ArdFederationMode = "auto" | "referrals" | "none";

export type ArdJsonObject = Record<string, unknown>;

export type ArdTrustManifest = {
  signatures?: readonly string[];
  transparencyLog?: string;
  attestations?: readonly string[];
  metadata?: ArdJsonObject;
};

export type ArdCatalogHost = {
  name?: string;
  displayName?: string;
  url?: string;
  description?: string;
  federation?: ArdFederationMode;
  metadata?: ArdJsonObject;
};

export type ArdCatalogEntry = {
  identifier: string;
  displayName: string;
  type: string;
  url?: string;
  data?: unknown;
  description?: string;
  tags?: readonly string[];
  capabilities?: readonly string[];
  representativeQueries?: readonly string[];
  version?: string;
  updatedAt?: string;
  metadata?: ArdJsonObject;
  trustManifest?: ArdTrustManifest;
};

export type ArdCatalogManifest = {
  specVersion: typeof ARD_SPEC_VERSION;
  host?: ArdCatalogHost;
  entries: readonly ArdCatalogEntry[];
  metadata?: ArdJsonObject;
};

export type ArdIdentifierParts = {
  publisher: string;
  segments: readonly string[];
  name: string;
};

export type ArdSearchFilter = Record<string, string | readonly string[]>;

export type ArdSearchRequest = {
  query?: string;
  filters?: ArdSearchFilter;
  pageSize?: number;
  pageToken?: string;
};

export type ArdSearchResult = {
  entry: ArdCatalogEntry;
  score: number;
  source?: string;
};

export type ArdSearchResponse = {
  results: readonly ArdSearchResult[];
  nextPageToken?: string;
};

export type ArdExploreRequest = {
  seed?: string;
  filters?: ArdSearchFilter;
  limit?: number;
};

export type ArdValidationSuccess<T> = {
  ok: true;
  value: T;
  warnings: readonly string[];
};

export type ArdValidationFailure = {
  ok: false;
  errors: readonly string[];
  warnings: readonly string[];
};

export type ArdValidationResult<T> = ArdValidationSuccess<T> | ArdValidationFailure;
