// Shared with browser startup paths that must not evaluate protocol schemas.
export const GATEWAY_OWNER_PROFILE_ID = "gateway-owner";
export const USER_PROFILE_ID_MAX_LENGTH = 128;

export const USER_PREFS_ENTRY_LIMIT = 32;
export const USER_PREFS_PROFILE_KEY_LIMIT = 128;
export const USER_PREFS_VALUE_BYTES = 4 * 1024;
export const GIT_COAUTHOR_PREFERENCE_KEY = "git.coauthor.enabled";

// Credit ships on for verified GitHub identities: an absent row is the default, not a
// refusal, so clearing the row on an account change restores the default instead of
// revoking credit. The preference API persists arbitrary JSON, so anything other than a
// missing row or literal `true` fails closed rather than publishing a person's trailer.
export function isGitCoauthorCreditEnabled(value: unknown): boolean {
  return value === undefined || value === true;
}
