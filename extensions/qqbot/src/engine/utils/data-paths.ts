/**
 * Centralised filename helpers for persisted QQBot state.
 *
 * Every persistence module routes file paths through these helpers so the
 * naming convention stays in sync and legacy migrations are handled
 * consistently.
 *
 * Key design decisions:
 * - Credential backup is keyed only by `accountId` because recovery runs
 *   exactly when the appId is missing from config.
 */

import path from "node:path";
import { getQQBotDataPath, normalizePath } from "./platform.js";

/**
 * Normalise an identifier so it is safe to embed in a filename.
 * Keeps alphanumerics, dot, underscore, dash; everything else becomes `_`.
 */
function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getCredentialBackupRoot(): string {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(normalizePath(stateDir), "qqbot", "data");
  }
  return getQQBotDataPath("data");
}

// ---- credential backup ----

/**
 * Per-accountId credential backup file. Not keyed by appId because the
 * whole point of this file is to recover credentials when appId is
 * missing from the live config.
 */
export function getCredentialBackupFile(accountId: string): string {
  return path.join(getCredentialBackupRoot(), `credential-backup-${safeName(accountId)}.json`);
}

/** Legacy single-file credential backup (pre-multi-account-isolation). */
export function getLegacyCredentialBackupFile(): string {
  return path.join(getCredentialBackupRoot(), "credential-backup.json");
}
