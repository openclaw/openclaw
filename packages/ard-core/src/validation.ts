// Runtime validation for Agent Resource Discovery manifests and entries.

import {
  ARD_MEDIA_TYPE_MCP_SERVER_LEGACY,
  ARD_SPEC_VERSION,
  type ArdCatalogEntry,
  type ArdCatalogHost,
  type ArdCatalogManifest,
  type ArdIdentifierParts,
  type ArdJsonObject,
  type ArdSearchRequest,
  type ArdTrustManifest,
  type ArdValidationResult,
  SUPPORTED_ARD_MCP_MEDIA_TYPES,
  STANDARD_ARD_MEDIA_TYPES,
} from "./types.js";

const IDENTIFIER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Returns true when a value is a non-array object record. */
export function isArdRecord(value: unknown): value is ArdJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalizes media type comparisons while preserving caller-controlled values elsewhere. */
export function normalizeArdMediaType(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const mediaType = value.trim().toLowerCase();
  return mediaType ? mediaType : undefined;
}

/** Returns true for media types listed by the ARD draft as standard resource descriptors. */
export function isStandardArdMediaType(value: unknown): boolean {
  const mediaType = normalizeArdMediaType(value);
  return mediaType ? (STANDARD_ARD_MEDIA_TYPES as readonly string[]).includes(mediaType) : false;
}

/** Returns true for both current and legacy MCP server-card media type spellings. */
export function isSupportedArdMcpMediaType(value: unknown): boolean {
  const mediaType = normalizeArdMediaType(value);
  return mediaType
    ? (SUPPORTED_ARD_MCP_MEDIA_TYPES as readonly string[]).includes(mediaType)
    : false;
}

/** Parses an ARD URN identifier into publisher, namespace segments, and terminal name. */
export function parseArdIdentifier(identifier: string): ArdIdentifierParts | null {
  const trimmed = identifier.trim();
  const parts = trimmed.split(":");
  if (parts.length < 4 || parts[0] !== "urn" || parts[1] !== "ai") {
    return null;
  }
  const publisher = parts[2];
  const segments = parts.slice(3);
  if (!publisher || !segments.length) {
    return null;
  }
  const tokens = [publisher, ...segments];
  if (tokens.some((token) => !IDENTIFIER_TOKEN_PATTERN.test(token))) {
    return null;
  }
  return {
    publisher,
    segments,
    name: segments.at(-1) ?? "",
  };
}

/** Validates one ARD catalog entry and returns a normalized copy. */
export function validateArdCatalogEntry(value: unknown): ArdValidationResult<ArdCatalogEntry> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isArdRecord(value)) {
    return failure(["entry must be an object"], warnings);
  }

  const identifier = requireString(value, "identifier", errors);
  if (identifier && !parseArdIdentifier(identifier)) {
    errors.push("identifier must be a valid urn:ai:<publisher>:<namespace>:<name> value");
  }

  const displayName = requireString(value, "displayName", errors);
  const type = requireString(value, "type", errors)?.toLowerCase();
  if (type === ARD_MEDIA_TYPE_MCP_SERVER_LEGACY) {
    warnings.push("type uses legacy application/mcp-server+json spelling");
  }

  const hasUrl = Object.hasOwn(value, "url");
  const hasData = Object.hasOwn(value, "data");
  if (hasUrl === hasData) {
    errors.push("entry must define exactly one of url or data");
  }

  const url = optionalString(value.url, "url", errors);
  if (hasUrl && url && !isHttpUrl(url)) {
    errors.push("url must be an http or https URL");
  }
  if (hasUrl && !url) {
    errors.push("url must be a non-empty string when present");
  }
  if (hasData && value.data === undefined) {
    errors.push("data must be defined when present");
  }

  const representativeQueries = optionalStringArray(
    value.representativeQueries,
    "representativeQueries",
    errors,
  );
  if (
    representativeQueries &&
    (representativeQueries.length < 2 || representativeQueries.length > 5)
  ) {
    warnings.push("representativeQueries should contain 2 to 5 entries");
  }

  const tags = optionalStringArray(value.tags, "tags", errors);
  const capabilities = optionalStringArray(value.capabilities, "capabilities", errors);
  const trustManifest = optionalTrustManifest(value.trustManifest, errors);
  const metadata = optionalRecord(value.metadata, "metadata", errors);
  const description = optionalString(value.description, "description", errors);
  const version = optionalString(value.version, "version", errors);
  const updatedAt = optionalString(value.updatedAt, "updatedAt", errors);

  if (errors.length || !identifier || !displayName || !type) {
    return failure(errors, warnings);
  }

  const entry: ArdCatalogEntry = {
    identifier,
    displayName,
    type,
    ...(url ? { url } : {}),
    ...(hasData ? { data: value.data } : {}),
    ...(description ? { description } : {}),
    ...(tags ? { tags } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(representativeQueries ? { representativeQueries } : {}),
    ...(version ? { version } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(metadata ? { metadata } : {}),
    ...(trustManifest ? { trustManifest } : {}),
  };
  return { ok: true, value: entry, warnings };
}

/** Validates an ARD catalog manifest and returns a normalized copy. */
export function validateArdCatalogManifest(
  value: unknown,
): ArdValidationResult<ArdCatalogManifest> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isArdRecord(value)) {
    return failure(["manifest must be an object"], warnings);
  }

  const specVersion = requireString(value, "specVersion", errors);
  if (specVersion && specVersion !== ARD_SPEC_VERSION) {
    errors.push(`specVersion must be ${ARD_SPEC_VERSION}`);
  }

  const entriesValue = value.entries;
  const entries: ArdCatalogEntry[] = [];
  if (!Array.isArray(entriesValue)) {
    errors.push("entries must be an array");
  } else {
    for (const [index, entryValue] of entriesValue.entries()) {
      const result = validateArdCatalogEntry(entryValue);
      warnings.push(...result.warnings.map((warning) => `entries[${index}]: ${warning}`));
      if (result.ok) {
        entries.push(result.value);
      } else {
        errors.push(...result.errors.map((error) => `entries[${index}]: ${error}`));
      }
    }
  }

  const host = optionalCatalogHost(value.host, errors);
  const metadata = optionalRecord(value.metadata, "metadata", errors);

  if (errors.length || specVersion !== ARD_SPEC_VERSION) {
    return failure(errors, warnings);
  }

  return {
    ok: true,
    value: {
      specVersion: ARD_SPEC_VERSION,
      ...(host ? { host } : {}),
      entries,
      ...(metadata ? { metadata } : {}),
    },
    warnings,
  };
}

/** Validates the common ARD registry search request shape used by local catalog search. */
export function validateArdSearchRequest(value: unknown): ArdValidationResult<ArdSearchRequest> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isArdRecord(value)) {
    return failure(["search request must be an object"], warnings);
  }
  const query = optionalString(value.query, "query", errors);
  const pageToken = optionalString(value.pageToken, "pageToken", errors);
  const filters = optionalSearchFilters(value.filters, errors);
  const pageSize = optionalPageSize(value.pageSize, errors);
  if (errors.length) {
    return failure(errors, warnings);
  }
  return {
    ok: true,
    value: {
      ...(query ? { query } : {}),
      ...(filters ? { filters } : {}),
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(pageToken ? { pageToken } : {}),
    },
    warnings,
  };
}

function requireString(record: ArdJsonObject, key: string, errors: string[]): string | undefined {
  const value = optionalString(record[key], key, errors);
  if (!value) {
    errors.push(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, key: string, errors: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    errors.push(`${key} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalStringArray(value: unknown, key: string, errors: string[]): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.push(`${key} must be an array of strings`);
    return undefined;
  }
  const normalized: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      errors.push(`${key}[${index}] must be a string`);
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed) {
      normalized.push(trimmed);
    }
  }
  return normalized;
}

function optionalRecord(value: unknown, key: string, errors: string[]): ArdJsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isArdRecord(value)) {
    errors.push(`${key} must be an object`);
    return undefined;
  }
  return value;
}

function optionalTrustManifest(value: unknown, errors: string[]): ArdTrustManifest | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isArdRecord(value)) {
    errors.push("trustManifest must be an object");
    return undefined;
  }
  const signatures = optionalStringArray(value.signatures, "trustManifest.signatures", errors);
  const attestations = optionalStringArray(
    value.attestations,
    "trustManifest.attestations",
    errors,
  );
  const transparencyLog = optionalString(
    value.transparencyLog,
    "trustManifest.transparencyLog",
    errors,
  );
  const metadata = optionalRecord(value.metadata, "trustManifest.metadata", errors);
  return {
    ...(signatures ? { signatures } : {}),
    ...(transparencyLog ? { transparencyLog } : {}),
    ...(attestations ? { attestations } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function optionalCatalogHost(value: unknown, errors: string[]): ArdCatalogHost | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isArdRecord(value)) {
    errors.push("host must be an object");
    return undefined;
  }
  const federation = optionalString(value.federation, "host.federation", errors);
  if (federation && !["auto", "referrals", "none"].includes(federation)) {
    errors.push("host.federation must be auto, referrals, or none");
  }
  const url = optionalString(value.url, "host.url", errors);
  if (url && !isHttpUrl(url)) {
    errors.push("host.url must be an http or https URL");
  }
  const name = optionalString(value.name, "host.name", errors);
  const displayName = optionalString(value.displayName, "host.displayName", errors);
  const description = optionalString(value.description, "host.description", errors);
  const metadata = optionalRecord(value.metadata, "host.metadata", errors);
  return {
    ...(name ? { name } : {}),
    ...(displayName ? { displayName } : {}),
    ...(url ? { url } : {}),
    ...(description ? { description } : {}),
    ...(federation ? { federation: federation as ArdCatalogHost["federation"] } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function optionalSearchFilters(
  value: unknown,
  errors: string[],
): Record<string, string | readonly string[]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isArdRecord(value)) {
    errors.push("filters must be an object");
    return undefined;
  }
  const filters: Record<string, string | readonly string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      filters[key] = entry;
      continue;
    }
    if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      filters[key] = entry;
      continue;
    }
    errors.push(`filters.${key} must be a string or array of strings`);
  }
  return filters;
}

function optionalPageSize(value: unknown, errors: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    errors.push("pageSize must be a positive integer");
    return undefined;
  }
  return Math.min(value, 100);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function failure(
  errors: readonly string[],
  warnings: readonly string[],
): ArdValidationResult<never> {
  return { ok: false, errors, warnings };
}
