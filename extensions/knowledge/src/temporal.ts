import type { Envelope } from "./model.js";

/** Source dates retain their precision; instants must carry an explicit offset. */
export function validSourceDate(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) {
    return false;
  }
  if (new Date(match[1]!).toISOString().slice(0, 10) !== match[1]) {
    return false;
  }
  if (!match[2]) {
    return true;
  }
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    return false;
  }
  return (
    match[5] === "Z" || (Number(match[5]!.slice(1, 3)) <= 23 && Number(match[5]!.slice(4)) <= 59)
  );
}
export function temporalProblems(m: Envelope): string[] {
  const issues: string[] = [];
  for (const key of ["occurred_at", "due_at", "valid_from", "valid_until", "expires_at"] as const) {
    if (m[key] !== undefined && !validSourceDate(m[key]!)) {
      issues.push(`Invalid ${key}`);
    }
  }
  if (m.valid_from && m.valid_until && Date.parse(m.valid_from) >= Date.parse(m.valid_until)) {
    issues.push("valid_until must follow valid_from");
  }
  if (
    m.kind !== "claim" &&
    (m.occurred_at !== undefined || m.owner !== undefined || m.due_at !== undefined)
  ) {
    issues.push("Occurrence and commitment fields require a claim");
  }
  if (m.claim_kind !== "commitment" && (m.owner !== undefined || m.due_at !== undefined)) {
    issues.push("Owner and due date require a commitment");
  }
  if (
    m.kind === "page" &&
    (m.valid_from !== undefined || m.valid_until !== undefined || m.expires_at !== undefined)
  ) {
    issues.push("Assertion validity requires a claim or relationship");
  }
  return issues;
}
/** Validity is [from, until). Expiry is exclusive. Occurrence and due dates never expire a record. */
export function activeNow(m: Envelope, now = Date.now()): boolean {
  return (
    m.lifecycle === "active" &&
    (!m.valid_from || Date.parse(m.valid_from) <= now) &&
    (!m.valid_until || Date.parse(m.valid_until) > now) &&
    (!m.expires_at || Date.parse(m.expires_at) > now)
  );
}

/** Date-only values are calendar dates, not UTC instants to shift into yesterday. */
export function formatSourceDate(value: string): string {
  if (!validSourceDate(value)) {
    return value;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(value))
    : new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(value));
}

/** Explain storage-day differences without changing source precision. */
export function sourceDateNote(value: string): string {
  if (!validSourceDate(value)) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "Date only · no time recorded";
  }
  const instant = new Date(value);
  const local = [
    instant.getFullYear(),
    String(instant.getMonth() + 1).padStart(2, "0"),
    String(instant.getDate()).padStart(2, "0"),
  ].join("-");
  return local !== instant.toISOString().slice(0, 10)
    ? `Stored as ${instant.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "";
}
