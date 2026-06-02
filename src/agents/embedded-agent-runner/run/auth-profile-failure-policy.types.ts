/**
 * Selects how embedded-attempt auth failures affect profile rotation.
 *
 * `shared` lets a failed profile participate in run-level failover; `local`
 * keeps the failure scoped to the current attempt so callers can preserve an
 * already-selected runtime auth profile.
 */
export type AuthProfileFailurePolicy = "shared" | "local";
