/**
 * Centralised filename helpers for persisted QQBot state.
 *
 * Every persistence module (admin resolver, startup greeting, credential
 * backup) routes file paths through these helpers so the naming convention
 * stays in sync and legacy migrations are handled consistently.
 *
 * Key design decisions:
 * - Admin / startup / upgrade-greeting files are keyed by
 *   `accountId-appId` so switching a QQ bot app under the same account
 *   slot isolates state.
 * - Credential backup is keyed only by `accountId` because recovery runs
 *   exactly when the appId is missing from config.
 */

import path from "node:path";
import { getQQBotDataDir } from "./platform.js";

/**
 * Normalise an identifier so it is safe to embed in a filename.
 * Keeps alphanumerics, dot, underscore, dash; everything else becomes `_`.
 */
export function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ---- admin openid ----

/** Per-(accountId, appId) admin marker file. */
export function getAdminMarkerFile(accountId: string, appId: string): string {
  return path.join(getQQBotDataDir("data"), `admin-${safeName(accountId)}-${safeName(appId)}.json`);
}

/** Legacy per-accountId admin marker file (pre-multi-app-isolation). */
export function getLegacyAdminMarkerFile(accountId: string): string {
  return path.join(getQQBotDataDir("data"), `admin-${accountId}.json`);
}

// ---- upgrade greeting target ----

/**
 * File remembering whoever triggered `/bot-upgrade`, so the next start
 * can greet that user with "upgrade complete".
 */
export function getUpgradeGreetingTargetFile(accountId: string, appId: string): string {
  return path.join(
    getQQBotDataDir("data"),
    `upgrade-greeting-target-${safeName(accountId)}-${safeName(appId)}.json`,
  );
}

// ---- startup greeting marker ----

/** Per-(accountId, appId) startup greeting marker file. */
export function getStartupMarkerFile(accountId: string, appId: string): string {
  return path.join(
    getQQBotDataDir("data"),
    `startup-marker-${safeName(accountId)}-${safeName(appId)}.json`,
  );
}

/** Legacy global startup marker file (pre-multi-account-isolation). */
export function getLegacyStartupMarkerFile(): string {
  return path.join(getQQBotDataDir("data"), "startup-marker.json");
}

// ---- credential backup ----

/**
 * Per-accountId credential backup file. Not keyed by appId because the
 * whole point of this file is to recover credentials when appId is
 * missing from the live config.
 */
export function getCredentialBackupFile(accountId: string): string {
  return path.join(getQQBotDataDir("data"), `credential-backup-${safeName(accountId)}.json`);
}

/** Legacy single-file credential backup (pre-multi-account-isolation). */
export function getLegacyCredentialBackupFile(): string {
  return path.join(getQQBotDataDir("data"), "credential-backup.json");
}
