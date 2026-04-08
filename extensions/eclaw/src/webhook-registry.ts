/**
 * Per-session webhook token registry for the E-Claw plugin.
 *
 * When a gateway account starts, it registers a random bearer token and
 * the accountId it should dispatch to. E-Claw echoes the token on every
 * push as `Authorization: Bearer <token>`. The webhook dispatcher looks
 * up the correct accountId by matching the bearer token so multiple
 * E-Claw accounts can share the single `/eclaw-webhook` HTTP route.
 *
 * Unauthenticated requests are always rejected — we do not fall back to
 * routing to a lone registered account, because that would accept any
 * POST from the public internet.
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
