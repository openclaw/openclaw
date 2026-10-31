import { normalizeOptionalString as normalizeId } from "openclaw/plugin-sdk/string-coerce-runtime";
type ActiveDiscordTurnThreadRoute = {
  accountId?: string;
  sourceChannelId: string;
  sourceMessageId: string;
  adoptedThreadId?: string;
  onThreadAdopted: (threadId: string) => Promise<void> | void;
  onThreadReplyDelivered?: (threadId: string) => void;
  onThreadAdoptionError?: (error: unknown) => void;
};

// Routes count their holders: the dispatch and a queued run can overlap.
const activeRoutes = new Map<string, Map<ActiveDiscordTurnThreadRoute, number>>();

export function beginDiscordActiveTurnThreadRoute(
  sessionKey: string | undefined,
  route: ActiveDiscordTurnThreadRoute,
): () => void {
  const key = normalizeId(sessionKey);
  if (!key) {
    return () => {};
  }
  const routes = activeRoutes.get(key) ?? new Map<ActiveDiscordTurnThreadRoute, number>();
  routes.set(route, (routes.get(route) ?? 0) + 1);
  activeRoutes.set(key, routes);
  return () => {
    const holders = (routes.get(route) ?? 1) - 1;
    if (holders > 0) {
      routes.set(route, holders);
      return;
    }
    routes.delete(route);
    if (routes.size === 0 && activeRoutes.get(key) === routes) {
      activeRoutes.delete(key);
    }
  };
}

/**
 * Holds a message's thread route during its dispatch. A message queued behind an
 * active turn runs after its dispatch has returned, so the queued run holds the
 * route again from admission until it settles.
 */
export function createDiscordActiveTurnThreadRouteHolder(
  sessionKey: string | undefined,
  route: ActiveDiscordTurnThreadRoute,
) {
  let releaseQueued: (() => void) | undefined;
  return {
    end: beginDiscordActiveTurnThreadRoute(sessionKey, route),
    holdQueued: () => {
      releaseQueued ??= beginDiscordActiveTurnThreadRoute(sessionKey, route);
    },
    releaseQueued: () => {
      releaseQueued?.();
      releaseQueued = undefined;
    },
  };
}

export async function notifyDiscordActiveTurnThreadCreated(params: {
  sessionKey?: string | null;
  accountId?: string | null;
  sourceChannelId?: string;
  sourceMessageId?: string;
  threadId?: string;
}): Promise<void> {
  const key = normalizeId(params.sessionKey ?? undefined);
  const threadId = normalizeId(params.threadId);
  const sourceChannelId = normalizeId(params.sourceChannelId);
  const sourceMessageId = normalizeId(params.sourceMessageId);
  const route = key
    ? Array.from(activeRoutes.get(key)?.keys() ?? []).find(
        (candidate) =>
          sourceChannelId === candidate.sourceChannelId &&
          sourceMessageId === candidate.sourceMessageId &&
          (!candidate.accountId || !params.accountId || candidate.accountId === params.accountId),
      )
    : undefined;
  if (!route || !threadId) {
    return;
  }
  route.adoptedThreadId = threadId;
  try {
    await route.onThreadAdopted(threadId);
  } catch (error) {
    route.onThreadAdoptionError?.(error);
  }
}

export function notifyDiscordActiveTurnThreadReplyDelivered(params: {
  sessionKey?: string | null;
  accountId?: string | null;
  threadId?: string;
}): boolean {
  const key = normalizeId(params.sessionKey ?? undefined);
  const threadId = normalizeId(params.threadId);
  if (!key || !threadId) {
    return false;
  }
  const route = Array.from(activeRoutes.get(key)?.keys() ?? []).find(
    (candidate) =>
      candidate.adoptedThreadId === threadId &&
      (!candidate.accountId || !params.accountId || candidate.accountId === params.accountId),
  );
  if (!route) {
    return false;
  }
  route.onThreadReplyDelivered?.(threadId);
  return true;
}
