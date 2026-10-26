import type { Evidence, LoadedRecord } from "./model.js";

export const sourceCount = (evidence: Evidence[] = []) =>
  new Set(evidence.map((e) => `${e.path}:${e.sha256}`)).size;

export function recordSummary({
  metadata,
  body: _body,
  raw: _raw,
  hash: _hash,
  redirected: _redirected,
  ...base
}: LoadedRecord) {
  const occurredAt =
    metadata.occurred_at ??
    (typeof metadata.fields?.occurred_at === "string" ? metadata.fields.occurred_at : undefined);
  return {
    ...base,
    recordedAt: metadata.recorded_at,
    updatedAt: metadata.updated_at,
    ...(occurredAt ? { occurredAt } : {}),
    ...(metadata.identity
      ? { identityStatus: metadata.identity.status, identityContext: metadata.identity.context }
      : {}),
    ...(metadata.from ? { from: metadata.from, to: metadata.to, label: metadata.label } : {}),
    ...(metadata.attribution_confidence
      ? { attributionConfidence: metadata.attribution_confidence }
      : {}),
    ...(metadata.source_event ? { sourceEvent: true } : {}),
  };
}
