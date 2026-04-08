/**
 * Per-session webhook token registry for the E-Claw plugin.
 *
 * When a gateway account starts, it registers a random bearer token and
 * the accountId it should dispatch to. E-Claw echoes the token on every
 * push as `Authorization: Bearer <token>`. The webhook dispatcher looks
 * up the correct accountId by matching the bearer token so multiple
 * E-Claw accounts can share the single `/eclaw-webhook` HTTP route.
 *
 * Authentication is strict and uniform for every webhook request:
 *
 *   - Header absent / empty / non-Bearer   -> 401, no fallback.
 *   - Bearer header present but token does not match an entry -> 401.
 *   - Bearer header present and token matches                 -> accountId.
 *
 * There is no "single registered account" fallback. A present-but-wrong
 * token is an active (failed) authentication attempt, not a missing
 * header, so accepting it would let any bogus token hit the dispatcher.
 */

type EclawTokenEntry = {
  accountId: string;
};

const registry = new Map<string, EclawTokenEntry>();

export function registerEclawWebhookToken(
  callbackToken: string,
  accountId: string,
): void {
  registry.set(callbackToken, { accountId });
}

export function unregisterEclawWebhookToken(callbackToken: string): void {
  registry.delete(callbackToken);
}

export function lookupEclawWebhookToken(
  authHeader: string | undefined,
): EclawTokenEntry | undefined {
  if (!authHeader?.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return undefined;
  }
  return registry.get(token);
}

export function eclawWebhookRegistrySize(): number {
  return registry.size;
}
