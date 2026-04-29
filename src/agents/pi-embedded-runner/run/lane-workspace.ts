import { enqueueCommandInLane } from "../../../process/command-queue.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { resolveUserPath } from "../../../utils.js";
import { isMarkdownCapableMessageChannel } from "../../../utils/message-channel.js";
import { resolveAgentWorkspaceDir } from "../../agent-scope.js";
import {
  redactRunIdentifier,
  resolveRunWorkspaceDir,
  type ResolveRunWorkspaceResult,
} from "../../workspace-run.js";
import { resolveGlobalLane, resolveSessionLane } from "../lanes.js";
import { log } from "../logger.js";
import type { RunEmbeddedPiAgentParams } from "./params.js";

type EnqueueCommandInLane = <T>(
  lane: string,
  task: () => Promise<T>,
  opts?: Parameters<CommandQueueEnqueueFn>[1],
) => Promise<T>;

export type EmbeddedRunQueuePlan = {
  sessionLane: string;
  globalLane: string;
  enqueueSession: CommandQueueEnqueueFn;
  enqueueGlobal: CommandQueueEnqueueFn;
};

export function buildEmbeddedRunQueuePlan(params: {
  sessionKey?: string;
  sessionId: string;
  lane?: string;
  enqueue?: CommandQueueEnqueueFn;
  enqueueInLane?: EnqueueCommandInLane;
}): EmbeddedRunQueuePlan {
  const enqueueInLane = params.enqueueInLane ?? enqueueCommandInLane;
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  // A caller-supplied enqueue function is an explicit override of lane routing.
  // Preserve that legacy escape hatch: such callers own serialization and any
  // cron -> nested deadlock guard themselves.
  const enqueueGlobal = params.enqueue ?? ((task, opts) => enqueueInLane(globalLane, task, opts));
  const enqueueSession = params.enqueue ?? ((task, opts) => enqueueInLane(sessionLane, task, opts));
  return {
    sessionLane,
    globalLane,
    enqueueSession,
    enqueueGlobal,
  };
}

export function resolveEmbeddedRunToolResultFormat(params: {
  toolResultFormat?: RunEmbeddedPiAgentParams["toolResultFormat"];
  messageChannel?: string;
  messageProvider?: string;
}): NonNullable<RunEmbeddedPiAgentParams["toolResultFormat"]> {
  if (params.toolResultFormat) {
    return params.toolResultFormat;
  }
  const channelHint = params.messageChannel ?? params.messageProvider;
  if (!channelHint) {
    return "markdown";
  }
  return isMarkdownCapableMessageChannel(channelHint) ? "markdown" : "plain";
}

export function isEmbeddedProbeSession(sessionId?: string): boolean {
  return sessionId?.startsWith("probe-") ?? false;
}

export function throwIfEmbeddedRunAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  const abortErr =
    reason !== undefined
      ? new Error("Operation aborted", { cause: reason })
      : new Error("Operation aborted");
  abortErr.name = "AbortError";
  throw abortErr;
}

export type EmbeddedRunWorkspaceContext = {
  workspaceResolution: ResolveRunWorkspaceResult;
  resolvedWorkspace: string;
  canonicalWorkspace: string;
  isCanonicalWorkspace: boolean;
};

export function resolveEmbeddedRunWorkspaceContext(params: {
  workspaceDir: RunEmbeddedPiAgentParams["workspaceDir"];
  sessionKey?: string;
  agentId?: string;
  config?: RunEmbeddedPiAgentParams["config"];
  env?: NodeJS.ProcessEnv;
}): EmbeddedRunWorkspaceContext {
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
    env: params.env,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const canonicalWorkspace = resolveUserPath(
    resolveAgentWorkspaceDir(params.config ?? {}, workspaceResolution.agentId, params.env),
    params.env,
  );
  return {
    workspaceResolution,
    resolvedWorkspace,
    canonicalWorkspace,
    isCanonicalWorkspace: canonicalWorkspace === resolvedWorkspace,
  };
}

export function logEmbeddedRunWorkspaceFallback(params: {
  workspaceResolution: ResolveRunWorkspaceResult;
  resolvedWorkspace: string;
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  warn?: (message: string) => void;
}): void {
  if (!params.workspaceResolution.usedFallback) {
    return;
  }
  const warn = params.warn ?? ((message) => log.warn(message));
  warn(
    `[workspace-fallback] caller=runEmbeddedPiAgent reason=${params.workspaceResolution.fallbackReason} run=${params.runId} session=${redactRunIdentifier(params.sessionId)} sessionKey=${redactRunIdentifier(params.sessionKey)} agent=${params.workspaceResolution.agentId} workspace=${redactRunIdentifier(params.resolvedWorkspace)}`,
  );
}
