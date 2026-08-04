import type { AuditEntry } from "../protocol/index.js";
import { REEF_AUDIT_MAX_ENTRIES } from "./state.js";

// Compact the in-memory audit window promptly instead of delaying the slice
// until a full window of stale entries has accumulated, so the retained buffer
// stays at the canonical window plus one small batch rather than twice it.
export const REEF_AUDIT_RETAIN_COMPACT_BATCH = 1_024;

export type ReefAuditRetention = {
  entries: AuditEntry[];
  start: number;
};

export function createReefAuditRetention(): ReefAuditRetention {
  return { entries: [], start: 0 };
}

export function pushReefAuditRetention(retention: ReefAuditRetention, entry: AuditEntry): void {
  retention.entries.push(entry);
  if (retention.entries.length - retention.start > REEF_AUDIT_MAX_ENTRIES) {
    retention.start += 1;
    if (retention.start >= REEF_AUDIT_RETAIN_COMPACT_BATCH) {
      retention.entries = retention.entries.slice(retention.start);
      retention.start = 0;
    }
  }
}

export function reefAuditRetentionEntries(retention: ReefAuditRetention): AuditEntry[] {
  return retention.entries.slice(retention.start);
}
