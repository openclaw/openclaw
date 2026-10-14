import { appendFileTransferAudit } from "./audit.js";

type AuditRecord = Parameters<typeof appendFileTransferAudit>[0];
type AuditIdentity = Pick<AuditRecord, "op" | "nodeId" | "nodeDisplayName" | "requestedPath">;

/** Keep one transfer's identity and original start time across its decision records. */
export function bindFileTransferAudit(identity: AuditIdentity, startedAt: number) {
  return (record: Omit<AuditRecord, keyof AuditIdentity | "durationMs">) =>
    appendFileTransferAudit({ ...identity, ...record, durationMs: Date.now() - startedAt });
}
