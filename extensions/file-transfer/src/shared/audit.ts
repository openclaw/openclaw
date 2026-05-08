// Append-only audit log for file-transfer operations.
//
// Records every decision (allow/deny/error) at the gateway-side tool layer in
// SQLite plugin state. Legacy ~/.openclaw/audit/file-transfer.jsonl files are
// doctor/migrate inputs only.
//
// Log records do NOT include file contents or hashes of secrets. They do
// include canonical paths and sha256 of the payload, so treat the audit
// rows as sensitive.

import { randomUUID } from "node:crypto";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export type FileTransferAuditOp = "file.fetch" | "dir.list" | "dir.fetch" | "file.write";

export const FILE_TRANSFER_AUDIT_PLUGIN_ID = "file-transfer";
export const FILE_TRANSFER_AUDIT_NAMESPACE = "audit";
export const FILE_TRANSFER_AUDIT_MAX_ENTRIES = 50_000;

export type FileTransferAuditDecision =
  | "allowed"
  | "allowed:once"
  | "allowed:always"
  | "denied:no_policy"
  | "denied:policy"
  | "denied:approval"
  | "denied:command_not_allowed"
  | "denied:symlink_escape"
  | "error";

export type FileTransferAuditRecord = {
  timestamp: string;
  op: FileTransferAuditOp;
  nodeId: string;
  nodeDisplayName?: string;
  requestedPath: string;
  canonicalPath?: string;
  decision: FileTransferAuditDecision;
  errorCode?: string;
  errorMessage?: string;
  sizeBytes?: number;
  sha256?: string;
  durationMs?: number;
  // Tying back to the agent that initiated the op
  requesterAgentId?: string;
  sessionKey?: string;
  // Reason text for denials
  reason?: string;
};

const AUDIT_STORE = createPluginStateKeyedStore<FileTransferAuditRecord>(
  FILE_TRANSFER_AUDIT_PLUGIN_ID,
  {
    namespace: FILE_TRANSFER_AUDIT_NAMESPACE,
    maxEntries: FILE_TRANSFER_AUDIT_MAX_ENTRIES,
  },
);

function auditKey(timestamp: string): string {
  return `${timestamp}:${randomUUID()}`;
}

/**
 * Append an audit record. Best-effort — failures are logged to stderr and
 * never propagated to the caller (the caller's operation is the source of
 * truth, not the audit write).
 */
export async function appendFileTransferAudit(
  record: Omit<FileTransferAuditRecord, "timestamp">,
): Promise<void> {
  try {
    const timestamp = new Date().toISOString();
    await AUDIT_STORE.register(auditKey(timestamp), {
      timestamp,
      ...record,
    });
  } catch (e) {
    process.stderr.write(`[file-transfer:audit] append failed: ${String(e)}\n`);
  }
}

export async function listFileTransferAuditRecordsForTests(): Promise<FileTransferAuditRecord[]> {
  return (await AUDIT_STORE.entries()).map((entry) => entry.value);
}
