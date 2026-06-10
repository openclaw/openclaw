import type { DiagnosticEventPrivateData } from "../api.js";

/** The opaque, core-bounded attribution bag (depth/keys/bytes already capped upstream). */
type ClientContextBag = NonNullable<DiagnosticEventPrivateData["clientContext"]>;

/** Defensive cap in case a value slips past the core size bounds. */
const MAX_CLIENT_CONTEXT_ATTRIBUTE_CHARS = 4096;

/**
 * Join keys shared by the lifecycle seed events (`session.state` / `message.queued`,
 * which carry clientContext) and the `model.call.*` events (which do not). Both
 * event families expose `sessionId` and/or `sessionKey`; we return every present
 * candidate so the cache can store/resolve under all of them and never miss the
 * join when the two event types populate different identity fields.
 */
export function clientContextKeys(evt: { sessionId?: string; sessionKey?: string }): string[] {
  const keys: string[] = [];
  if (evt.sessionId) {
    keys.push(evt.sessionId);
  }
  if (evt.sessionKey) {
    keys.push(evt.sessionKey);
  }
  return keys;
}

/**
 * Stamp generic `openclaw.client.<key>` attributes from the opaque bag onto a span
 * attribute object. Vendor-neutral: core never interprets these keys and neither do
 * we — a downstream OTel Collector renames e.g. `openclaw.client.agentId` ->
 * `prov.agent.id`. Scalars are set directly; nested values are JSON-encoded and
 * bounded; null/undefined are skipped.
 */
export function assignClientContextAttributes(
  attributes: Record<string, string | number | boolean>,
  clientContext: ClientContextBag | undefined,
): void {
  if (!clientContext) {
    return;
  }
  for (const key of Object.keys(clientContext)) {
    const value = clientContext[key];
    if (value === null || value === undefined) {
      continue;
    }
    const attrKey = `openclaw.client.${key}`;
    if (typeof value === "string") {
      attributes[attrKey] = value.slice(0, MAX_CLIENT_CONTEXT_ATTRIBUTE_CHARS);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      attributes[attrKey] = value;
      continue;
    }
    attributes[attrKey] = JSON.stringify(value).slice(0, MAX_CLIENT_CONTEXT_ATTRIBUTE_CHARS);
  }
}

/** Bound on remembered entries (counts each candidate key separately). */
const DEFAULT_MAX_REMEMBERED_ENTRIES = 1024;

export type ClientContextCache = {
  remember(keys: string[], clientContext: ClientContextBag | undefined): void;
  resolve(keys: string[]): ClientContextBag | undefined;
  clear(): void;
};

/**
 * Per-run cache of the seeded clientContext. Populated from the lifecycle seed
 * events (`session.state` / `message.queued`) and read when building the child
 * `model.call.*` spans, which do not carry the bag themselves. Bounded by
 * insertion order so a long-lived gateway process cannot accumulate stale runs.
 */
export function createClientContextCache(
  maxEntries = DEFAULT_MAX_REMEMBERED_ENTRIES,
): ClientContextCache {
  const byKey = new Map<string, ClientContextBag>();
  return {
    remember(keys, clientContext) {
      if (!clientContext || keys.length === 0) {
        return;
      }
      for (const key of keys) {
        // Refresh insertion order so the most-recently-seen run survives eviction.
        byKey.delete(key);
        byKey.set(key, clientContext);
      }
      while (byKey.size > maxEntries) {
        const oldest = byKey.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        byKey.delete(oldest);
      }
    },
    resolve(keys) {
      for (const key of keys) {
        const hit = byKey.get(key);
        if (hit) {
          return hit;
        }
      }
      return undefined;
    },
    clear() {
      byKey.clear();
    },
  };
}
