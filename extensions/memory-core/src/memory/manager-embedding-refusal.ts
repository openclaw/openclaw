// Memory Core owns the remembered refusal of an implicit embeddings endpoint.
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const EMBEDDING_REFUSAL_META_KEY = "memory_embedding_refusal_v1";

/** The endpoint an implicit embedding provider calls. */
export type MemoryEmbeddingEndpoint = {
  provider: string;
  baseUrl: string;
  model: string;
  headers?: unknown;
};

/** An endpoint that answered "no embeddings here" for one embedding identity. */
export type MemoryEmbeddingRefusal = MemoryEmbeddingEndpoint & {
  status: number;
  recordedAt: string;
};

/** Statuses that mean the endpoint has no embeddings route, not that a call failed. */
const PERSISTENT_REFUSAL_STATUSES = new Set([404, 405, 501]);
/** Statuses that disable embeddings until the next probe window, never across processes. */
const TRANSIENT_REFUSAL_STATUSES = new Set([401, 403, 429]);

/** Reads the endpoint identity a remote adapter publishes in its cache key. */
export function readMemoryEmbeddingEndpoint(value: unknown): MemoryEmbeddingEndpoint | undefined {
  const record = asNullableRecord(value);
  const provider = record?.provider;
  const baseUrl = record?.baseUrl;
  const model = record?.model;
  // Routing headers (tenant, deployment) pick the endpoint as much as the URL does.
  const headers = record?.headers;
  return typeof provider === "string" && typeof baseUrl === "string" && typeof model === "string"
    ? { provider, baseUrl, model, ...(headers === undefined ? {} : { headers }) }
    : undefined;
}

export function parseMemoryEmbeddingRefusal(value: unknown): MemoryEmbeddingRefusal | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const endpoint = readMemoryEmbeddingEndpoint(parsed);
  const record = asNullableRecord(parsed);
  const status = record?.status;
  const recordedAt = record?.recordedAt;
  return endpoint && typeof status === "number" && typeof recordedAt === "string"
    ? { ...endpoint, status, recordedAt }
    : null;
}

/**
 * Adapters publish headers as a record or as [name, value] pairs; order is not identity, and
 * values are already credential-free in the adapter's cache key.
 */
function headerIdentity(endpoint: MemoryEmbeddingEndpoint): string {
  const { headers } = endpoint;
  const entries = Array.isArray(headers)
    ? headers
    : Object.entries(asNullableRecord(headers) ?? {});
  return JSON.stringify(entries.map((entry) => JSON.stringify(entry)).toSorted());
}

export function isSameMemoryEmbeddingEndpoint(
  left: MemoryEmbeddingEndpoint,
  right: MemoryEmbeddingEndpoint,
): boolean {
  return (
    left.provider === right.provider &&
    left.baseUrl === right.baseUrl &&
    left.model === right.model &&
    headerIdentity(left) === headerIdentity(right)
  );
}

/** The HTTP status an embeddings endpoint answered with, through operation wrappers. */
function readEmbeddingHttpStatus(err: unknown): number | undefined {
  let current = err;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if ("status" in current && typeof current.status === "number") {
      return current.status;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export function classifyEmbeddingEndpointFailure(
  err: unknown,
): { kind: "persistent" | "transient"; status: number } | undefined {
  const status = readEmbeddingHttpStatus(err);
  if (status === undefined) {
    return undefined;
  }
  if (PERSISTENT_REFUSAL_STATUSES.has(status)) {
    return { kind: "persistent", status };
  }
  if (TRANSIENT_REFUSAL_STATUSES.has(status) || (status >= 500 && status <= 599)) {
    return { kind: "transient", status };
  }
  return undefined;
}

export function formatMemoryEmbeddingRefusal(refusal: MemoryEmbeddingRefusal): string {
  const host = URL.parse(refusal.baseUrl)?.host ?? refusal.baseUrl;
  return (
    `keyword-only: ${host} refused embeddings for ${refusal.model} (${refusal.status}); ` +
    "set memory.search.provider or memory.search.remote to use embeddings"
  );
}
