/**
 * Whitelists, enums, thresholds, and PII masking for the infringement domain.
 * Mirrors the constants in leading-v2.0 InfringementCase / InfringementLink.
 *
 * Projection is whitelist-only: queries SELECT exactly these columns so internal
 * flags (secret, status) and raw JSON blobs (accept_checks_json, report_json)
 * never reach the LLM verbatim, and PII (phone/email) is masked at the edge.
 */

/** Case processing stages (InfringementCase::STAGE_*). */
export const CASE_STAGES = ["draft", "accepted", "analyzing", "analyzed", "failed"] as const;
export type CaseStage = (typeof CASE_STAGES)[number];

/** Acceptance conclusions (InfringementCase::ACC_*). */
export const ACCEPT_CONCLUSIONS = ["accept", "amend", "reject", "pending"] as const;
export type AcceptConclusion = (typeof ACCEPT_CONCLUSIONS)[number];

/** Per-link analyze status (InfringementLink::ST_*). */
export const LINK_STATUSES = ["pending", "analyzing", "done", "failed"] as const;

/** A link scoring at/above this counts as a qualifying violation (DOC_THRESHOLD). */
export const VIOLATION_SCORE_THRESHOLD = 6;

/** Default and max row caps for the `cases` list mode. */
export const CASE_LIST_DEFAULT_LIMIT = 20;
export const CASE_LIST_MAX_LIMIT = 50;

/**
 * Columns returned by the `cases` list mode. Deliberately excludes phone/email
 * (PII) and all internal flags.
 */
export const CASE_LIST_COLUMNS = [
  "id",
  "case_no",
  "reporter",
  "enterprise_type",
  "target",
  "stage",
  "accept_conclusion",
  "analyze_mode",
  "overall_score",
  "progress",
  "link_count",
  "handler",
  "created_at",
  "updated_at",
] as const;

/** Extra columns shown only in `case_detail` (PII columns are masked, not raw). */
export const CASE_DETAIL_EXTRA_COLUMNS = [
  "accept_risk",
  "accept_notice",
  "secret",
  "archived",
] as const;

/** Link columns surfaced in `case_detail` / `account`. No report_json blob. */
export const LINK_COLUMNS = [
  "id",
  "case_id",
  "url",
  "title",
  "platform",
  "account",
  "analyze_status",
  "score",
  "violation_types",
  "media_name",
  "media_type",
  "region",
  "publish_time",
  "link_kind",
  "issue_summary",
  "manual_score",
] as const;

/** Report summary columns (no raw report_json). */
export const REPORT_COLUMNS = [
  "overall_score",
  "severity_label",
  "mode",
  "summary",
  "risk_notes",
] as const;

/** Coerce a DB scalar to a trimmed string; non-scalars become "". */
function coerceScalar(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

/** Mask a phone number: keep first 3 and last 4 digits (138****5678). */
export function maskPhone(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const s = coerceScalar(value);
  if (s === "") {
    return null;
  }
  if (s.length <= 4) {
    return "****";
  }
  if (s.length <= 7) {
    return s.slice(0, 1) + "****";
  }
  return s.slice(0, 3) + "****" + s.slice(-4);
}

/** Mask an email: keep first 2 chars of local part + domain (ab***@x.com). */
export function maskEmail(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const s = coerceScalar(value);
  if (s === "") {
    return null;
  }
  const at = s.indexOf("@");
  if (at <= 0) {
    return "***";
  }
  const local = s.slice(0, at);
  const domain = s.slice(at);
  const head = local.slice(0, Math.min(2, local.length));
  return head + "***" + domain;
}
