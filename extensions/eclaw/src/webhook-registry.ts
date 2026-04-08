/**
 * Per-session webhook token registry for the E-Claw plugin.
 *
 * When a gateway account starts, it registers a random bearer token and
 * the accountId it should dispatch to. E-Claw echoes the token on every
 * push as `Authorization: Bearer <token>`. The webhook dispatcher looks
 * up the correct accountId by matching the bearer token so multiple
 * E-Claw accounts can share the single `/eclaw-webhook` HTTP route.
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
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    const hit = registry.get(token);
    if (hit) {
      return hit;
    }
  }
  // Fallback: if only one handler is registered, route to it. Some
  // E-Claw backend versions do not echo the callback token.
  if (registry.size === 1) {
    const [, only] = registry.entries().next().value ?? [];
    return only;
  }
  return undefined;
}

export function eclawWebhookRegistrySize(): number {
  return registry.size;
}
