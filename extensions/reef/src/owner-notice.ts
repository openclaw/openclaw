import type { PluginRuntime } from "openclaw/plugin-sdk/core";

type ResolveAgentRouteParams = Parameters<
  PluginRuntime["channel"]["routing"]["resolveAgentRoute"]
>[0];

export interface ReefOwnerNotice {
  text: string;
  contextKey: string;
  peer?: string;
  wakeAgent?: boolean;
}

export function createReefOwnerNoticeHandler(params: {
  runtime: PluginRuntime;
  cfg: ResolveAgentRouteParams["cfg"];
  accountId: string;
  handle: string;
}): (notice: ReefOwnerNotice) => Promise<void> {
  return async (notice) => {
    const route = params.runtime.channel.routing.resolveAgentRoute({
      cfg: params.cfg,
      channel: "reef",
      accountId: params.accountId,
      peer: { kind: "direct", id: notice.peer ?? params.handle },
    });
    const queued = params.runtime.system.enqueueSystemEvent(notice.text, {
      sessionKey: route.sessionKey,
      contextKey: notice.contextKey,
    });
    if (!queued || !notice.wakeAgent) {
      return;
    }
    params.runtime.system.requestHeartbeat({
      source: "other",
      intent: "immediate",
      reason: "reef:delivery-rejected",
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });
  };
}
