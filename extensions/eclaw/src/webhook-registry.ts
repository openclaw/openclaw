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
  if (!authHeader) {
    return undefined;
  }
  // RFC 7235 §2.1: auth-scheme is case-insensitive. Clients or proxies
  // may send `bearer <token>` (lowercase) or any other case variant,
  // and rejecting those as unauthorized would break inbound delivery
  // even when the token is valid. Match the scheme case-insensitively,
  // then extract the token from whatever the client actually sent.
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(authHeader);
  if (!match) {
    return undefined;
  }
  const token = match[1];
  if (!token) {
    return undefined;
  }
  return registry.get(token);
}

export function eclawWebhookRegistrySize(): number {
  return registry.size;
}
