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
    const json = JSON.stringify(value);
    if (json) {
      attributes[attrKey] = json.slice(0, MAX_CLIENT_CONTEXT_ATTRIBUTE_CHARS);
    }
  }
}
