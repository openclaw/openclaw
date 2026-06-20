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
  type ArdTrustAttestation,
  type ArdTrustProvenance,
  type ArdTrustSchema,
  type ArdTrustManifest,
  type ArdValidationResult,
  SUPPORTED_ARD_MCP_MEDIA_TYPES,
  STANDARD_ARD_MEDIA_TYPES,
} from "./types.js";

const IDENTIFIER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DNS_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

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
  if (parts.length < 4 || parts[0] !== "urn" || parts[1] !== "air") {
    return null;
  }
  const publisher = parts[2];
  const segments = parts.slice(3);
  if (!publisher || !segments.length) {
    return null;
  }
  if (!isFullyQualifiedDomainName(publisher)) {
    return null;
  }
  if (segments.some((token) => !IDENTIFIER_TOKEN_PATTERN.test(token))) {
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
    errors.push("identifier must be a valid urn:air:<publisher-fqdn>:<namespace>:<name> value");
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

function requireNestedString(value: unknown, key: string, errors: string[]): string | undefined {
  const normalized = optionalString(value, key, errors);
  if (!normalized) {
    errors.push(`${key} must be a non-empty string`);
  }
  return normalized;
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
  requireOnlyKeys(
    value,
    "trustManifest",
    ["identity", "identityType", "trustSchema", "attestations", "provenance", "signature"],
    errors,
  );
  const identity = requireNestedString(value.identity, "trustManifest.identity", errors);
  const identityType = optionalString(value.identityType, "trustManifest.identityType", errors);
  if (identityType && !["spiffe", "did", "https", "other"].includes(identityType)) {
    errors.push("trustManifest.identityType must be spiffe, did, https, or other");
  }
  const trustSchema = optionalTrustSchema(value.trustSchema, errors);
  const attestations = optionalTrustAttestations(value.attestations, errors);
  const provenance = optionalTrustProvenance(value.provenance, errors);
  const signature = optionalString(value.signature, "trustManifest.signature", errors);
  if (!identity) {
    return undefined;
  }
  return {
    identity,
    ...(identityType ? { identityType: identityType as ArdTrustManifest["identityType"] } : {}),
    ...(trustSchema ? { trustSchema } : {}),
    ...(attestations ? { attestations } : {}),
    ...(provenance ? { provenance } : {}),
    ...(signature ? { signature } : {}),
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
  requireOnlyKeys(
    value,
    "host",
    ["displayName", "identifier", "documentationUrl", "logoUrl", "trustManifest"],
    errors,
  );
  const displayName = requireNestedString(value.displayName, "host.displayName", errors);
  const identifier = optionalString(value.identifier, "host.identifier", errors);
  const documentationUrl = optionalString(value.documentationUrl, "host.documentationUrl", errors);
  if (documentationUrl && !isUri(documentationUrl)) {
    errors.push("host.documentationUrl must be a URI");
  }
  const logoUrl = optionalString(value.logoUrl, "host.logoUrl", errors);
  if (logoUrl && !isUri(logoUrl)) {
    errors.push("host.logoUrl must be a URI");
  }
  const trustManifest = optionalTrustManifest(value.trustManifest, errors);
  if (!displayName) {
    return undefined;
  }
  return {
    displayName,
    ...(identifier ? { identifier } : {}),
    ...(documentationUrl ? { documentationUrl } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    ...(trustManifest ? { trustManifest } : {}),
  };
}

function optionalTrustSchema(value: unknown, errors: string[]): ArdTrustSchema | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isArdRecord(value)) {
    errors.push("trustManifest.trustSchema must be an object");
    return undefined;
  }
  requireOnlyKeys(
    value,
    "trustManifest.trustSchema",
    ["identifier", "version", "governanceUri", "verificationMethods"],
    errors,
  );
  const identifier = requireNestedString(
    value.identifier,
    "trustManifest.trustSchema.identifier",
    errors,
  );
  const version = requireNestedString(value.version, "trustManifest.trustSchema.version", errors);
  const governanceUri = optionalString(
    value.governanceUri,
    "trustManifest.trustSchema.governanceUri",
    errors,
  );
  if (governanceUri && !isUri(governanceUri)) {
    errors.push("trustManifest.trustSchema.governanceUri must be a URI");
  }
  const verificationMethods = optionalStringArray(
    value.verificationMethods,
    "trustManifest.trustSchema.verificationMethods",
    errors,
  );
  if (!identifier || !version) {
    return undefined;
  }
  return {
    identifier,
    version,
    ...(governanceUri ? { governanceUri } : {}),
    ...(verificationMethods ? { verificationMethods } : {}),
  };
}

function optionalTrustAttestations(
  value: unknown,
  errors: string[],
): ArdTrustAttestation[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.push("trustManifest.attestations must be an array of objects");
    return undefined;
  }
  const attestations: ArdTrustAttestation[] = [];
  for (const [index, entry] of value.entries()) {
    const key = `trustManifest.attestations[${index}]`;
    if (!isArdRecord(entry)) {
      errors.push(`${key} must be an object`);
      continue;
    }
    requireOnlyKeys(entry, key, ["type", "uri", "mediaType", "digest"], errors);
    const type = requireNestedString(entry.type, `${key}.type`, errors);
    const uri = requireNestedString(entry.uri, `${key}.uri`, errors);
    if (uri && !isUri(uri)) {
      errors.push(`${key}.uri must be a URI`);
    }
    const mediaType = requireNestedString(entry.mediaType, `${key}.mediaType`, errors);
    const digest = optionalString(entry.digest, `${key}.digest`, errors);
    if (type && uri && mediaType) {
      attestations.push({
        type,
        uri,
        mediaType,
        ...(digest ? { digest } : {}),
      });
    }
  }
  return attestations;
}

function optionalTrustProvenance(
  value: unknown,
  errors: string[],
): ArdTrustProvenance[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.push("trustManifest.provenance must be an array of objects");
    return undefined;
  }
  const provenance: ArdTrustProvenance[] = [];
  for (const [index, entry] of value.entries()) {
    const key = `trustManifest.provenance[${index}]`;
    if (!isArdRecord(entry)) {
      errors.push(`${key} must be an object`);
      continue;
    }
    requireOnlyKeys(entry, key, ["relation", "sourceId", "sourceDigest"], errors);
    const relation = requireNestedString(entry.relation, `${key}.relation`, errors);
    if (relation && !["derivedFrom", "publishedFrom", "copiedFrom"].includes(relation)) {
      errors.push(`${key}.relation must be derivedFrom, publishedFrom, or copiedFrom`);
    }
    const sourceId = requireNestedString(entry.sourceId, `${key}.sourceId`, errors);
    const sourceDigest = optionalString(entry.sourceDigest, `${key}.sourceDigest`, errors);
    if (relation && sourceId) {
      provenance.push({
        relation: relation as ArdTrustProvenance["relation"],
        sourceId,
        ...(sourceDigest ? { sourceDigest } : {}),
      });
    }
  }
  return provenance;
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

function isUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

function isFullyQualifiedDomainName(value: string): boolean {
  if (value.length > 253 || !value.includes(".")) {
    return false;
  }
  const labels = value.split(".");
  return labels.every((label) => DNS_LABEL_PATTERN.test(label));
}

function requireOnlyKeys(
  record: ArdJsonObject,
  key: string,
  allowedKeys: readonly string[],
  errors: string[],
): void {
  const allowed = new Set(allowedKeys);
  for (const entryKey of Object.keys(record)) {
    if (!allowed.has(entryKey)) {
      errors.push(`${key}.${entryKey} is not supported by the ARD schema`);
    }
  }
}

function failure(
  errors: readonly string[],
  warnings: readonly string[],
): ArdValidationResult<never> {
  return { ok: false, errors, warnings };
}
