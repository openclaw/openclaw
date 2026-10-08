/**
 * Live-provider model error classifiers.
 *
 * Probe and fallback code uses these string checks to distinguish missing or
 * deprecated model ids from generic provider/runtime failures.
 */
/**
 * Access, permission, or account wording means another authorized profile may
 * still serve the model. "continued paid access" on a retirement notice does not.
 */
const ACCOUNT_SCOPED_MODEL_NOT_FOUND_RE = new RegExp(
  String.raw`\b(?:do not have access|does not have access|don't have access|dont have access|` +
    String.raw`not have access|no access to|access denied|insufficient permissions?|` +
    String.raw`permission denied|not authorized|unauthorized|forbidden)\b|` +
    String.raw`\bchatgpt account\b|\b(?:your|this|the) account\b`,
  "i",
);

/**
 * Affirmative evidence the selected model id is gone for the provider.
 * Generic 404 pages and bare not_found_error codes are intentionally absent:
 * those shapes do not prove every account lacks the model.
 */
const PROVIDER_WIDE_MODEL_ABSENCE_PATTERNS: readonly RegExp[] = [
  /\bunknown model\b/i,
  /model(?:[_\-\s])?not(?:[_\-\s])?found/i,
  /\bmodel\b.{0,80}?\bnot found\b/i,
  /\bmodels\/[^\s]+ is not found\b/i,
  /\bmodel\b[^.]{0,120}?\bdoes not exist\b/i,
  /\bmodel\b[^.]{0,160}?\b(?:retired|deprecated|no longer available)\b/i,
  /\b(?:retired|deprecated|no longer available)\b[^.]{0,80}?\bmodel\b/i,
  /\bis not a valid model id\b/i,
  /\bno endpoints found for\b/i,
];

/** Returns whether a provider error message indicates a missing or retired model id. */
export function isModelNotFoundErrorMessage(raw: string): boolean {
  const msg = raw.trim();
  return (
    /no endpoints found for/i.test(msg) ||
    /\brouter not found\b/i.test(msg) ||
    /unknown model/i.test(msg) ||
    // "Not available" alone also describes outages; require missing-model evidence.
    /model(?:[_\-\s])?not(?:[_\-\s])?found|\bmodel\b.{0,60}?\bnot found\b/i.test(msg) ||
    (/\b404\b/.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) ||
    /not_found_error/i.test(msg) ||
    /\bnot supported model\b/i.test(msg) ||
    // Account restrictions require the account suffix, keeping capability errors out.
    /\bmodel\b[^.]{0,120}?\bis not supported when using\b[^.]{0,80}?\bwith a ChatGPT account\b/i.test(
      msg,
    ) ||
    (/model:\s*[a-z0-9._/-]+/i.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) ||
    /models\/[^\s]+ is not found/i.test(msg) ||
    (/model/i.test(msg) && /does not exist/i.test(msg)) ||
    (/selected model/i.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) ||
    (/model/i.test(msg) && /deprecated/i.test(msg) && /(upgrade|transition) to/i.test(msg)) ||
    (/stealth model/i.test(msg) && /find it here/i.test(msg)) ||
    /is not a valid model id/i.test(msg) ||
    (/invalid model/i.test(msg) && !/invalid model reference/i.test(msg))
  );
}

/**
 * True only for text that affirmatively says this model does not exist, was
 * retired, or was deprecated. A broad missing-model match with denial phrases
 * removed is not enough: empty, unknown, generic 404, and bare not_found_error
 * messages stay on profile rotation, as does any access, permission, or
 * account wording.
 */
export function isProviderWideModelNotFoundErrorMessage(raw: string): boolean {
  const msg = raw.trim();
  if (!msg || ACCOUNT_SCOPED_MODEL_NOT_FOUND_RE.test(msg)) {
    return false;
  }
  if (/\binvalid model\b/i.test(msg) && !/\binvalid model reference\b/i.test(msg)) {
    return true;
  }
  return PROVIDER_WIDE_MODEL_ABSENCE_PATTERNS.some((pattern) => pattern.test(msg));
}
