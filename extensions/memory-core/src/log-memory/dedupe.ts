import { createHash } from "node:crypto";

// Deterministic id keyed on (timestamp, service, message). ISO timestamp keeps
// the hash stable across timezones; service is normalized to "" when absent so
// the same log emitted twice in different parsers still collides.
export function computeEntryId(params: {
  timestamp: Date;
  service?: string;
  message: string;
}): string {
  const ts = params.timestamp.toISOString();
  const svc = params.service ?? "";
  const hash = createHash("sha256");
  hash.update(`${ts}${svc}${params.message}`);
  return hash.digest("hex");
}
