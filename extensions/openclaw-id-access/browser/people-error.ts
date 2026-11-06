// The Access page owns its display copy; Gateway and protocol refusal codes stay unchanged.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** The attempted operation, used only to describe failures at the display boundary. */
export type PeopleErrorAction = "load" | "update" | "approve";

/** Plain copy and a separately sanitized diagnostic for a collapsed disclosure. */
export type PeopleError = { message: string; diagnostic: string };

const OWNER_BROWSER =
  "This browser cannot manage access to this claw. Use an approved owner browser.";
const MESSAGES: Readonly<Record<string, string>> = {
  no_owner_key: OWNER_BROWSER,
  not_owner:
    "Only the owner can see who has access. Open this page from an approved owner browser.",
  not_direct: "Use an approved owner browser to change access.",
  missing_capability: OWNER_BROWSER,
  not_linked: "Turn on remote access on the computer that runs this claw before inviting people.",
  unconfigured:
    "Remote access is not set up for this claw. Ask the person who manages it to finish setup.",
  seq_conflict:
    "Access changed while you were making this update. Refresh this page and review the current access before trying again.",
  invite_not_pending:
    "This request is no longer waiting for approval. Refresh this page to see its status.",
  invite_unknown: "This invitation is no longer available. Refresh this page to see its status.",
  invite_used:
    "This invitation is already in use or has been used. Refresh this page to see its status.",
  // This code covers both a changed request and access beyond the invitation's ceiling.
  target_mismatch:
    "This update does not match the current access or invitation. Refresh this page and review the request and its allowed access before making changes.",
  expired:
    "This access approval expired. Refresh this page and review the current access before continuing.",
  not_an_owner:
    "This browser's owner access was removed. Use another approved owner browser or your recovery kit.",
  caps_escalation:
    "This browser can't give another device more owner permissions than it has. Use your recovery kit to grant them.",
  limit_reached:
    "This claw has reached its limit for people or devices. Remove one to add another.",
  not_yet_valid:
    "This access approval is not valid yet. Check the date and time on your device and the computer running this claw.",
};

const VERIFICATION_CODES = new Set([
  "bad_signature",
  "wrong_signer",
  "root_mismatch",
  "wrong_claw",
  "host_mismatch",
  "rollback",
  "bad_proof",
  "audience_mismatch",
]);

// Read only the error envelope's public string fields, never stringify arbitrary payloads.
function stringField(value: unknown, key: string): string | undefined {
  if (isRecord(value)) {
    const field = value[key];
    return typeof field === "string" ? field : undefined;
  }
  return undefined;
}

// The Gateway wraps protocol refusal codes in details; prose is never a classifier.
function errorCode(error: unknown): string | undefined {
  const details = isRecord(error) ? error.details : undefined;
  return (
    stringField(details, "code") ?? stringField(error, "code") ?? stringField(error, "gatewayCode")
  );
}

// Keep the host's credential redaction and additionally remove invite URLs and recovery codes.
// Redact before bounding so a secret cut midway cannot evade matching. No stack or payload is shown.
function diagnosticText(
  error: unknown,
  code: string | undefined,
  redact: (text: string) => string,
): string {
  const message = typeof error === "string" ? error : (stringField(error, "message") ?? "");
  const raw = [code, message].filter(Boolean).join(": ");
  const safe = redact(
    raw
      .replace(/\b(?:https?|wss?):\/\/[^\s<>"'`]+/gi, "[redacted URL]")
      .replace(/\bOCK1(?:[\s-]*[0-9A-Z]){31,}/gi, "[redacted recovery code]")
      .replace(/[\p{Cc}\p{Cf}]/gu, " "),
  )
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted value]")
    .trim();
  return safe.length > 1200 ? `${safe.slice(0, 1199)}…` : safe;
}

/** Map stable refusal codes without treating an uncertain write as a confirmed failure. */
export function peopleError(
  error: unknown,
  action: PeopleErrorAction,
  redact: (text: string) => string,
): PeopleError {
  const code = errorCode(error);
  const fallback =
    action === "load"
      ? "Could not load people. Refresh this page to try again."
      : action === "approve"
        ? "Could not confirm whether access was approved. Refresh this page and check the person's access before approving again."
        : "Could not confirm the access update. Refresh this page and check who has access before making another change.";
  // Broad transport/unavailable/unknown failures can occur after the authority commits.
  // Only explicit protocol refusals justify a more specific cause or recovery instruction.
  const message =
    code && Object.hasOwn(MESSAGES, code)
      ? MESSAGES[code]!
      : code && VERIFICATION_CODES.has(code)
        ? "Access could not be verified. Do not continue with this request. Use an approved owner browser to review access to this claw."
        : fallback;
  return { message, diagnostic: diagnosticText(error, code, redact) };
}
