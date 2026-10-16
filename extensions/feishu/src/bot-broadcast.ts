import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";

export function createFeishuBroadcastIngressSettlement(params: {
  lifecycle?: FeishuIngressLifecycle;
  replayClaim?: ChannelReplayClaimHandle;
  onReplayCommitError?: (error: unknown) => void;
  onAdopted?: () => void;
  trackTask?: (task: Promise<void>) => void;
}): {
  createLane: (replayClaim?: ChannelReplayClaimHandle) => {
    lifecycle: FeishuIngressLifecycle;
    onDispatchComplete: (dispatched: boolean) => Promise<void>;
    onDispatchFailed: (error: unknown) => Promise<void>;
  };
  onLanePending: () => void;
  onDispatchComplete: () => Promise<void>;
  onDispatchFailed: (error: unknown) => Promise<void>;
} {
  type LaneState = {
    replayClaim?: ChannelReplayClaimHandle;
    adopting?: boolean;
    status: "pending" | "deferred" | "completed" | "failed";
  };

  const lanes = new Set<LaneState>();
  const failures: unknown[] = [];
  const fallbackAbort = new AbortController();
  let fanoutSettled = false;
  let terminal: "adopted" | "abandoned" | undefined;
  let terminalSettled = false;
  let finalizing = false;
  let deferred = false;
  const settlement = createDeferred<void>();
  params.trackTask?.(settlement.promise);
  const finishSettlement = () => {
    if (terminalSettled && ![...lanes].some((lane) => lane.adopting)) {
      settlement.resolve();
    }
  };

  const beginFinalizing = () => {
    if (finalizing) {
      return;
    }
    finalizing = true;
    params.lifecycle?.onAdoptionFinalizing();
  };
  const defer = () => {
    if (deferred) {
      return;
    }
    deferred = true;
    params.lifecycle?.onDeferred();
  };
  const reportReplayCommitError = (error: unknown) => {
    try {
      params.onReplayCommitError?.(error);
    } catch {
      // Reporting cannot undo an already adopted durable turn.
    }
  };
  const abandon = async (error: unknown) => {
    if (terminal) {
      return;
    }
    terminal = "abandoned";
    params.replayClaim?.release({ error });
    try {
      await params.lifecycle?.onAbandoned();
    } finally {
      fallbackAbort.abort(error);
      terminalSettled = true;
      finishSettlement();
    }
  };
  const adopt = async () => {
    if (terminal) {
      return;
    }
    // Choose one terminal action. Re-entrant terminal callbacks are best effort;
    // accepted lane commits remain tracked through their own completion.
    terminal = "adopted";
    try {
      beginFinalizing();
      await params.lifecycle?.onAdopted();
      try {
        params.onAdopted?.();
      } catch {
        // Local cleanup cannot reopen an already adopted durable turn.
      }
      try {
        await params.replayClaim?.commit();
      } catch (error) {
        reportReplayCommitError(error);
      }
    } catch (error) {
      terminal = undefined;
      await abandon(error).catch(() => undefined);
      throw error;
    } finally {
      terminalSettled = true;
      finishSettlement();
    }
  };
  const maybeSettle = async () => {
    if (!fanoutSettled || terminal) {
      return;
    }
    if (failures.length > 0 || [...lanes].some((lane) => lane.status === "failed")) {
      await abandon(
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Feishu broadcast dispatch failed"),
      );
      return;
    }
    if ([...lanes].some((lane) => lane.status !== "completed")) {
      return;
    }
    await adopt();
  };

  return {
    createLane: (replayClaim) => {
      const lane: LaneState = { replayClaim, status: "pending" };
      lanes.add(lane);
      return {
        lifecycle: {
          abortSignal: params.lifecycle?.abortSignal ?? fallbackAbort.signal,
          onAdopted: async () => {
            if (
              terminal ||
              lane.adopting ||
              lane.status === "completed" ||
              lane.status === "failed"
            ) {
              return;
            }
            lane.adopting = true;
            try {
              beginFinalizing();
              try {
                await lane.replayClaim?.commit();
              } catch (error) {
                reportReplayCommitError(error);
              }
              lane.status = "completed";
              await maybeSettle();
            } finally {
              lane.adopting = false;
              if (terminal) {
                finishSettlement();
              }
            }
          },
          onDeferred: () => {
            if (lane.status !== "pending") {
              return;
            }
            lane.status = "deferred";
            defer();
          },
          onDeferredHeartbeat: () => params.lifecycle?.onDeferredHeartbeat?.(),
          deferredHeartbeatIntervalMs: params.lifecycle?.deferredHeartbeatIntervalMs,
          onAdoptionFinalizing: beginFinalizing,
          onAbandoned: async () => {
            if (lane.adopting || lane.status === "completed" || lane.status === "failed") {
              return;
            }
            lane.status = "failed";
            lane.replayClaim?.release({ error: new Error("feishu-broadcast-turn-abandoned") });
            await maybeSettle();
          },
        },
        onDispatchComplete: async (dispatched) => {
          if (lane.adopting || lane.status !== "pending") {
            return;
          }
          const error = new Error(
            dispatched
              ? "feishu broadcast dispatch returned before turn adoption"
              : "feishu broadcast lane was not dispatched",
          );
          lane.status = "failed";
          failures.push(error);
          lane.replayClaim?.release({ error });
        },
        onDispatchFailed: async (error) => {
          failures.push(error);
          if (!lane.adopting && lane.status !== "completed") {
            lane.status = "failed";
            lane.replayClaim?.release({ error });
          }
          await maybeSettle();
        },
      };
    },
    onLanePending: defer,
    onDispatchComplete: async () => {
      fanoutSettled = true;
      await maybeSettle();
    },
    onDispatchFailed: async (error) => {
      failures.push(error);
      fanoutSettled = true;
      await maybeSettle();
    },
  };
}

export function resolveBroadcastAgents(cfg: ClawdbotConfig, peerId: string): string[] | null {
  const broadcast = (cfg as Record<string, unknown>).broadcast;
  if (!broadcast || typeof broadcast !== "object") {
    return null;
  }
  const agents = (broadcast as Record<string, unknown>)[peerId];
  return Array.isArray(agents) && agents.length > 0 ? (agents as string[]) : null;
}

export function buildBroadcastSessionKey(
  baseSessionKey: string,
  originalAgentId: string,
  targetAgentId: string,
): string {
  const prefix = `agent:${originalAgentId}:`;
  return baseSessionKey.startsWith(prefix)
    ? `agent:${targetAgentId}:${baseSessionKey.slice(prefix.length)}`
    : baseSessionKey;
}
