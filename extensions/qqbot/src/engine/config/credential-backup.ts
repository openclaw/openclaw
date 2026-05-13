/**
 * Credential backup & recovery backed by SQLite plugin state.
 *
 * Solves the "hot-upgrade interrupted, appId/secret vanished from
 * openclaw.json" failure mode without writing sidecar JSON files.
 * Legacy `credential-backup*.json` files are imported by doctor only.
 */

import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const QQBOT_PLUGIN_ID = "qqbot";
const CREDENTIAL_BACKUP_NAMESPACE = "credential-backups";
const credentialBackupStore = createPluginStateSyncKeyedStore<CredentialBackup>(QQBOT_PLUGIN_ID, {
  namespace: CREDENTIAL_BACKUP_NAMESPACE,
  maxEntries: 1000,
});

interface CredentialBackup {
  accountId: string;
  appId: string;
  clientSecret: string;
  savedAt: string;
}

/** Persist a credential snapshot (called once gateway reaches READY). */
export function saveCredentialBackup(accountId: string, appId: string, clientSecret: string): void {
  if (!appId || !clientSecret) {
    return;
  }
  try {
    credentialBackupStore.register(accountId, {
      accountId,
      appId,
      clientSecret,
      savedAt: new Date().toISOString(),
    });
  } catch {
    /* best-effort — ignore */
  }
}

/**
 * Load a credential snapshot for `accountId` from SQLite plugin state.
 */
export function loadCredentialBackup(accountId?: string): CredentialBackup | null {
  if (!accountId) {
    return null;
  }
  try {
    const data = credentialBackupStore.lookup(accountId);
    if (data?.appId && data.clientSecret) {
      return data;
    }
  } catch {
    /* unavailable store — ignore */
  }
  return null;
}
