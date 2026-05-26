import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { _ as ChatRunState, g as ChatAbortControllerEntry } from "./types-BMFYBAxt.js";
import { WebSocketServer } from "ws";
import { Server } from "node:http";

//#region src/infra/heartbeat-runner.d.ts
type HeartbeatRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};
//#endregion
//#region src/plugins/services.d.ts
type PluginServicesHandle = {
  stop: () => Promise<void>;
};
//#endregion
//#region src/gateway/server-startup-post-attach.d.ts
type GatewayPostReadySidecarHandle = {
  stop: () => void;
};
//#endregion
//#region src/gateway/server-close.d.ts
type ShutdownResult = {
  durationMs: number;
  warnings: string[];
};
declare function runGatewayClosePrelude(params: {
  stopDiagnostics?: () => void;
  clearSkillsRefreshTimer?: () => void;
  skillsChangeUnsub?: () => void;
  disposeAuthRateLimiter?: () => void;
  disposeBrowserAuthRateLimiter: () => void;
  stopModelPricingRefresh?: () => void;
  stopChannelHealthMonitor?: () => void;
  stopReadinessEventLoopHealth?: () => void;
  clearSecretsRuntimeSnapshot?: () => void;
  closeMcpServer?: () => Promise<void>;
}): Promise<void>;
declare function createGatewayCloseHandler(params: {
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  releasePluginRouteRegistry?: (() => void) | null;
  channelIds?: readonly ChannelId[];
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  postReadySidecars?: readonly GatewayPostReadySidecarHandle[];
  disposeSessionMcpRuntimes?: () => Promise<void>;
  disposeBundleLspRuntimes?: () => Promise<void>;
  cron: {
    stop: () => void;
  };
  heartbeatRunner: HeartbeatRunner;
  updateCheckStop?: (() => void) | null;
  stopTaskRegistryMaintenance?: (() => Promise<void> | void) | null;
  nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
  broadcast: (event: string, payload: unknown, opts?: {
    dropIfSlow?: boolean;
  }) => void;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  agentUnsub: (() => void) | null;
  heartbeatUnsub: (() => void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
  chatRunState: ChatRunState;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  removeChatRun: (sessionId: string, clientRunId: string, sessionKey?: string) => {
    sessionKey: string;
    clientRunId: string;
  } | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  getPendingReplyCount?: () => number;
  clients: Set<{
    socket: {
      close: (code: number, reason: string) => void;
    };
  }>;
  configReloader: {
    stop: () => Promise<void>;
  };
  wss: WebSocketServer;
  httpServer: Server;
  httpServers?: Server[];
  drainActiveSessionsForShutdown?: (params: {
    reason: "shutdown" | "restart";
    totalTimeoutMs?: number;
  }) => Promise<{
    emittedSessionIds: string[];
    timedOut: boolean;
  }>;
}): (opts?: {
  reason?: string;
  restartExpectedMs?: number | null;
  drainTimeoutMs?: number | null;
}) => Promise<ShutdownResult>;
//#endregion
//#region src/gateway/session-reset-service.d.ts
type DrainActiveSessionsForShutdownResult = {
  emittedSessionIds: string[];
  timedOut: boolean;
};
/**
 * Emit a typed `session_end` for every session that received `session_start`
 * but did not yet receive a paired `session_end`. The bounded total timeout
 * mirrors the gateway lifecycle hook timeout so a slow plugin cannot block
 * SIGTERM/SIGINT past the runtime's overall shutdown grace window.
 *
 * Sessions that have already been finalized through replace / reset / delete /
 * compaction are forgotten from the tracker by `emitGatewaySessionEndPluginHook`
 * before this drain runs, so they will not be double-fired here.
 */
declare function drainActiveSessionsForShutdown(params: {
  reason: "shutdown" | "restart";
  totalTimeoutMs?: number;
}): Promise<DrainActiveSessionsForShutdownResult>;
//#endregion
export { ShutdownResult, createGatewayCloseHandler, drainActiveSessionsForShutdown, runGatewayClosePrelude };