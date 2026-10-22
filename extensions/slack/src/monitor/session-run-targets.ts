import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { SlackMonitorContext } from "./context.js";
import type { SlackEventScope } from "./event-scope.js";

type SlackSessionAddress = {
  channelId: string;
  threadTs?: string;
  eventScope?: SlackEventScope;
};

type SlackSessionRunTarget = {
  route: ResolvedAgentRoute;
  isActive: () => boolean;
};

export async function captureSlackSessionTargetGuard(
  ctx: SlackMonitorContext,
  route: ResolvedAgentRoute,
  isActive?: () => boolean,
) {
  return captureSessionEntryCurrentCheckAsync({
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    storePath: resolveStorePath(ctx.cfg.session?.store, { agentId: route.agentId }),
    isActive,
  });
}

// Reloaded turn contexts inherit the same Bolt app; each new monitor owns a new app.
type ActivePublisher = SlackSessionRunTarget & { replyParentDeletion?: AbortController };
const runs = new WeakMap<SlackMonitorContext["app"], Map<string, Set<ActivePublisher>>>();

function addressKey(address: SlackSessionAddress): string {
  return JSON.stringify([address.eventScope?.teamId ?? "", address.channelId, address.threadTs]);
}

/** Registers the exact publisher before status/output; the dispatch owner must release it. */
export function registerSlackSessionRun(
  ctx: SlackMonitorContext,
  address: SlackSessionAddress,
  route: ResolvedAgentRoute,
  replyParentDeletion?: AbortController,
): () => void {
  // A deferred registration for this same turn must not revive a deleted parent.
  if (!address.threadTs || replyParentDeletion?.signal.aborted) {
    return () => {};
  }
  const byAddress = runs.get(ctx.app) ?? new Map<string, Set<ActivePublisher>>();
  runs.set(ctx.app, byAddress);
  const key = addressKey(address);
  const targets = byAddress.get(key) ?? new Set<ActivePublisher>();
  byAddress.set(key, targets);
  const target = { route, isActive: () => targets.has(target), replyParentDeletion };
  targets.add(target);
  return () => {
    targets.delete(target);
    // A completed dispatch must not erase another publisher or a replacement registration.
    if (targets.size === 0 && byAddress.get(key) === targets) {
      byAddress.delete(key);
    }
  };
}

/** Retire publication to this exact deleted message; the agent run and its session stay intact. */
export function retireSlackReplyParent(
  ctx: SlackMonitorContext,
  address: SlackSessionAddress & { threadTs: string },
): boolean {
  const byAddress = runs.get(ctx.app);
  const key = addressKey(address);
  const publishers = byAddress?.get(key);
  if (!publishers) {
    return false;
  }
  byAddress?.delete(key);
  for (const { replyParentDeletion } of publishers) {
    replyParentDeletion?.abort();
  }
  publishers.clear();
  return true;
}

export function getSlackSessionRuns(
  ctx: SlackMonitorContext,
  address: SlackSessionAddress,
): SlackSessionRunTarget[] {
  const targets = [...(runs.get(ctx.app)?.get(addressKey(address)) ?? [])];
  return [...new Map(targets.map((target) => [target.route.sessionKey, target])).values()].map(
    (target) => ({
      route: target.route,
      isActive: () =>
        targets.some(
          (candidate) =>
            candidate.route.sessionKey === target.route.sessionKey && candidate.isActive(),
        ),
    }),
  );
}
