// Best-effort credential-shape filter. Conservative: better to under-remember
// than to persist a token. Phase 2 needs a stronger redactor.

const SK_PREFIX = /\bsk-[A-Za-z0-9_-]{16,}\b/;
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/;
const GITHUB_PAT = /\bghp_[A-Za-z0-9]{20,}\b/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

// A long, dense, mixed-case-with-digits run that looks like an opaque
// credential (base64-ish or hex-ish), e.g. session keys or bearer tokens.
const OPAQUE_RUN = /[A-Za-z0-9+/=_-]{32,}/;

export function looksLikeSecret(text: string): boolean {
  if (SK_PREFIX.test(text)) {
    return true;
  }
  if (SLACK_TOKEN.test(text)) {
    return true;
  }
  if (GITHUB_PAT.test(text)) {
    return true;
  }
  if (JWT.test(text)) {
    return true;
  }
  const opaque = OPAQUE_RUN.exec(text);
  if (opaque) {
    const run = opaque[0];
    const hasUpper = /[A-Z]/.test(run);
    const hasLower = /[a-z]/.test(run);
    const hasDigit = /\d/.test(run);
    if (hasUpper && hasLower && hasDigit) {
      return true;
    }
  }
  return false;
}
