import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type EventSessionRoutingPolicy,
  resolveEventSessionRoutingPolicy,
} from "../infra/event-session-routing.js";

export type ExecCompletionSessionGeneration = {
  sessionId: string;
  lifecycleRevision?: string;
};

export type AgentRunIdentityOptions = {
  sessionId?: string;
  runId?: string;
  trigger?: string;
  jobId?: string;
  memoryFlushWritePath?: string;
};

export type ExecCompletionRoutingOptions = {
  agentAccountId?: string;
  sessionKey?: string;
  runSessionKey?: string;
  execCompletionSessionKey?: string;
  execCompletionSessionGeneration?: ExecCompletionSessionGeneration;
};

export function resolveExecCompletionRouting(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  runSessionKey?: string;
  completionSessionKey?: string;
  completionSessionGeneration?: ExecCompletionSessionGeneration;
  channel?: string;
  accountId?: string;
}): {
  notifySessionKey?: string;
  eventRouting: EventSessionRoutingPolicy;
} {
  const notifySessionKey = params.completionSessionKey ?? params.runSessionKey ?? params.sessionKey;
  return {
    notifySessionKey,
    eventRouting: {
      ...resolveEventSessionRoutingPolicy({
        cfg: params.cfg,
        sessionKey: notifySessionKey,
        channel: params.channel,
        accountId: params.accountId,
      }),
      ...(params.completionSessionKey &&
      params.completionSessionKey !== (params.runSessionKey ?? params.sessionKey)
        ? {
            isolateCompletionRun: true,
            expectedSessionGeneration: params.completionSessionGeneration,
            sessionStore: params.cfg?.session?.store,
          }
        : {}),
    },
  };
}
