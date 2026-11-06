import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

// Correlates hook authorization with execute: session fields differ across
// that boundary in production and provider tool-call ids are not globally
// unique, so the hook mints a UUID returned via adjusted params (handed
// through unchanged by core); model-supplied values are always overwritten.
export const AUTHORIZATION_NONCE_PARAM = "authorizationNonce";

type PendingRequest = {
  agentId: string;
  toolCallId: string;
  slug: string;
  reason: string;
};

// Approval callbacks are not awaited by core. Join their writes across broker
// instances before reading SQLite; this tracks work, never authorization.
const pendingWrites = new Map<string, { request: PendingRequest; completion: Promise<void> }>();

function matchesRequest(candidate: PendingRequest, request: PendingRequest): boolean {
  return (
    candidate.agentId === request.agentId &&
    candidate.toolCallId === request.toolCallId &&
    candidate.slug === request.slug &&
    candidate.reason === request.reason
  );
}

export async function registerPendingAuthorization<T extends PendingRequest>(
  store: PluginStateKeyedStore<T>,
  nonce: string,
  authorization: T,
  ttlMs: number,
): Promise<void> {
  const completion = store.register(nonce, authorization, { ttlMs });
  const { agentId, toolCallId, slug, reason } = authorization;
  pendingWrites.set(nonce, { request: { agentId, toolCallId, slug, reason }, completion });
  try {
    await completion;
  } finally {
    pendingWrites.delete(nonce);
  }
}

export async function consumePendingAuthorization<T extends PendingRequest>(
  store: PluginStateKeyedStore<T>,
  request: PendingRequest,
  nonce: string | undefined,
): Promise<T | undefined> {
  const pendingWrite = nonce !== undefined ? pendingWrites.get(nonce) : undefined;
  const writes =
    nonce !== undefined
      ? pendingWrite
        ? [pendingWrite.completion]
        : []
      : [...pendingWrites.values()]
          .filter((write) => matchesRequest(write.request, request))
          .map((write) => write.completion);
  const settled = await Promise.allSettled(writes);
  for (const result of settled) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  return nonce !== undefined
    ? await store.consume(nonce)
    : await consumeUniquePendingAuthorization(store, request);
}

// Fallback when the nonce param was dropped: before_tool_call results merge
// last-writer-wins, so another plugin returning params can strip the nonce.
// A single unambiguous match on caller identity is safe to honor; anything
// ambiguous fails closed.
async function consumeUniquePendingAuthorization<T extends PendingRequest>(
  store: PluginStateKeyedStore<T>,
  request: PendingRequest,
): Promise<T | undefined> {
  let match: string | undefined;
  for (const entry of await store.entries()) {
    const candidate = entry.value;
    if (!matchesRequest(candidate, request)) {
      continue;
    }
    if (match !== undefined) {
      return undefined;
    }
    match = entry.key;
  }
  const consumed = match === undefined ? undefined : await store.consume(match);
  return consumed && matchesRequest(consumed, request) ? consumed : undefined;
}
