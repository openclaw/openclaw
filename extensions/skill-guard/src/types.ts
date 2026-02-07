/**
 * Cloud Skill Store API response types.
 */

/** SHA256 hex hash (64 chars, lowercase). */
export type Sha256Hex = string;

/** Relative file path using forward-slash separators. */
export type RelFilePath = string;

/** A single skill entry inside the manifest. */
export type ManifestSkill = {
  version: string;
  publisher?: string;
  verified?: boolean;
  fileCount: number;
  files: Record<RelFilePath, Sha256Hex>;
};

/** Store metadata included in every manifest response. */
export type ManifestStore = {
  name: string;
  version: string;
};

/** Full manifest response from `GET /api/v1/skill-guard/manifest`. */
export type ManifestResponse = {
  store: ManifestStore;
  syncIntervalSeconds: number;
  blocklist: string[];
  skills: Record<string, ManifestSkill>;
};

/** Response from `GET /api/v1/skill-guard/skills/:name`. */
export type SingleSkillResponse = {
  name: string;
  version: string;
  fileCount: number;
  files: Record<RelFilePath, Sha256Hex>;
  publisher?: string;
  downloadUrl?: string;
};

/** Audit event types. */
export type AuditEventType =
  | "config_sync"
  | "config_sync_failed"
  | "load_pass"
  | "blocked"
  | "sideload_pass"
  | "sideload_warn"
  | "sideload_blocked"
  | "not_in_store"
  | "verification_off"
  | "cache_fallback";

/** A single audit log record (JSONL). */
export type AuditRecord = {
  ts: string;
  event: AuditEventType;
  skill?: string;
  source?: string;
  reason?: string;
  detail?: string;
};
