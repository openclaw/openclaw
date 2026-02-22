"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import {
  useGatewayConnectionState,
  useGatewayEvents,
  type GatewayEvent,
  type GatewayConnectionState,
} from "@/lib/hooks/use-gateway-events";

interface PollingConfig {
  fetchTasks: () => Promise<void>;
  fetchActivity: () => Promise<void>;
  fetchGatewayStatus: () => Promise<void>;
  batchWindowMs?: number;
  fallbackIntervalMs?: number;
}

interface PendingSyncFlags {
  tasks: boolean;
  activity: boolean;
  status: boolean;
  checkCompletion: boolean;
}

function classifyGatewayEvent(event: GatewayEvent): PendingSyncFlags {
  const lower = (event.event || "unknown").toLowerCase();
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;
  const chatState =
    typeof payload?.state === "string" ? payload.state.toLowerCase() : null;
  const isChatDelta = lower.startsWith("chat.") && chatState === "delta";
  const isChatTerminal =
    lower.startsWith("chat.") &&
    (chatState === "final" || chatState === "error" || chatState === "aborted");

  if (isChatDelta) {
    // Streaming token events can arrive at high frequency; don't re-fetch core
    // board/activity/status state for every delta.
    return {
      tasks: false,
      activity: false,
      status: false,
      checkCompletion: false,
    };
  }

  const taskRelated =
    isChatTerminal ||
    lower.includes("task.") ||
    lower.includes("dispatch") ||
    lower.includes("orchestrator");

  const activityRelated =
    taskRelated ||
    lower.startsWith("cron.") ||
    lower.includes("approval");

  const statusRelated =
    lower.startsWith("health") ||
    lower.startsWith("status") ||
    lower.startsWith("agents.") ||
    lower.startsWith("channels.") ||
    lower.startsWith("skills.");

  return {
    tasks: taskRelated,
    activity: activityRelated,
    status: statusRelated || taskRelated,
    checkCompletion: taskRelated || isChatTerminal,
  };
}

/**
 * Event-driven data sync hook.
 * Uses gateway event stream and falls back to slow polling when disconnected.
 */
export function usePolling({
  fetchTasks,
  fetchActivity,
  fetchGatewayStatus,
  batchWindowMs = 160,
  fallbackIntervalMs = 30_000,
}: PollingConfig) {
  const [connectionState, setConnectionState] =
    useState<GatewayConnectionState>("connecting");

  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCompletionCheckRef = useRef(0);
  const lastSyncAtRef = useRef({
    tasks: 0,
    activity: 0,
    status: 0,
  });
  const pendingRef = useRef<PendingSyncFlags>({
    tasks: false,
    activity: false,
    status: false,
    checkCompletion: false,
  });

  const flush = useCallback(async () => {
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }

    const pending = pendingRef.current;
    pendingRef.current = {
      tasks: false,
      activity: false,
      status: false,
      checkCompletion: false,
    };

    if (pending.checkCompletion) {
      try {
        const now = Date.now();
        if (now - lastCompletionCheckRef.current >= 15_000) {
          lastCompletionCheckRef.current = now;
          await fetch("/api/tasks/check-completion");
        }
      } catch {
        // Ignore completion-check errors.
      }
    }

    const jobs: Array<Promise<void>> = [];
    const now = Date.now();
    if (pending.tasks && now - lastSyncAtRef.current.tasks >= 1200) {
      lastSyncAtRef.current.tasks = now;
      jobs.push(fetchTasks());
    }
    if (pending.activity && now - lastSyncAtRef.current.activity >= 2500) {
      lastSyncAtRef.current.activity = now;
      jobs.push(fetchActivity());
    }
    if (pending.status && now - lastSyncAtRef.current.status >= 1500) {
      lastSyncAtRef.current.status = now;
      jobs.push(fetchGatewayStatus());
    }

    if (jobs.length > 0) {
      await Promise.all(jobs);
    }
  }, [fetchTasks, fetchActivity, fetchGatewayStatus]);

  const queueSync = useCallback(
    (flags: Partial<PendingSyncFlags>) => {
      pendingRef.current = {
        tasks: pendingRef.current.tasks || !!flags.tasks,
        activity: pendingRef.current.activity || !!flags.activity,
        status: pendingRef.current.status || !!flags.status,
        checkCompletion:
          pendingRef.current.checkCompletion || !!flags.checkCompletion,
      };

      if (!batchTimerRef.current) {
        batchTimerRef.current = setTimeout(() => {
          flush().catch(() => {
            // Ignore flush errors; next event/fallback will re-sync.
          });
        }, batchWindowMs);
      }
    },
    [flush, batchWindowMs]
  );

  const poll = useCallback(async () => {
    queueSync({
      tasks: true,
      activity: true,
      status: true,
      checkCompletion: true,
    });
  }, [queueSync]);

  const handleConnectionState = useCallback((state: GatewayConnectionState) => {
    setConnectionState(state);
  }, []);

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type !== "gateway_event") {return;}
      queueSync(classifyGatewayEvent(event));
    },
    [queueSync]
  );

  useGatewayConnectionState(handleConnectionState);
  useGatewayEvents(handleGatewayEvent);

  // Initial hydration
  useEffect(() => {
    poll().catch(() => {
      // Ignore initial sync failures.
    });
  }, [poll]);

  // Slow fallback polling when the event stream is disconnected
  useEffect(() => {
    const intervalId = setInterval(() => {
      if (connectionState !== "connected") {
        poll().catch(() => {
          // Ignore fallback polling errors.
        });
      }
    }, fallbackIntervalMs);

    return () => clearInterval(intervalId);
  }, [connectionState, fallbackIntervalMs, poll]);

  useEffect(() => {
    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
      }
    };
  }, []);

  return { poll, connectionState };
}

/**
 * Hook for refreshing task comments with event-driven updates and fallback polling.
 */
export function useCommentPolling(
  taskId: string,
  fetchComments: () => Promise<void>,
  onRefresh: () => Promise<void> | void,
  fallbackIntervalMs = 12_000
) {
  const [connectionState, setConnectionState] =
    useState<GatewayConnectionState>("connecting");
  const onRefreshRef = useRef(onRefresh);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlightRef = useRef(false);
  const lastRefreshAtRef = useRef(0);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {return;}
    refreshInFlightRef.current = true;
    try {
      await fetchComments();
      await Promise.resolve(onRefreshRef.current());
      lastRefreshAtRef.current = Date.now();
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [fetchComments]);

  const scheduleRefresh = useCallback(
    (baseDelayMs = 220) => {
      if (refreshTimerRef.current) {return;}
      const elapsed = Date.now() - lastRefreshAtRef.current;
      const minGapMs = 1500;
      const waitMs = elapsed >= minGapMs ? baseDelayMs : minGapMs - elapsed;
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        refresh().catch(() => {
          // Ignore transient refresh failures.
        });
      }, waitMs);
    },
    [refresh]
  );

  const handleConnectionState = useCallback((state: GatewayConnectionState) => {
    setConnectionState(state);
  }, []);

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (!taskId) {return;}
      if (event.type !== "gateway_event") {return;}
      const name = (event.event || "").toLowerCase();
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : null;
      const eventTaskId =
        typeof payload?.taskId === "string"
          ? payload.taskId
          : typeof payload?.task_id === "string"
            ? payload.task_id
            : null;
      if (eventTaskId && eventTaskId !== taskId) {return;}
      if (
        name.includes("task") ||
        name.includes("dispatch") ||
        name.includes("orchestrator")
      ) {
        scheduleRefresh();
      }
    },
    [scheduleRefresh, taskId]
  );

  useGatewayConnectionState(handleConnectionState);
  useGatewayEvents(handleGatewayEvent);

  useEffect(() => {
    refresh().catch(() => {
      // Ignore initial load failures.
    });
  }, [taskId, refresh]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      if (connectionState !== "connected") {
        scheduleRefresh(350);
      }
    }, fallbackIntervalMs);
    return () => clearInterval(intervalId);
  }, [connectionState, fallbackIntervalMs, scheduleRefresh]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);
}
