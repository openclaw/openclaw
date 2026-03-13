/**
 * Health probe for external monitoring.
 * Reports system status (healthy/degraded/unhealthy) based on:
 * - Lifecycle engine cycle recency
 * - Exchange connectivity
 * - Risk controller state
 * - In-flight order count
 *
 * Also provides a heartbeat file writer for external cron/watchdog checks.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type ExchangeHealthStoreLike = {
  listAll(): Array<{
    exchangeId: string;
    connected: boolean;
    consecutiveFailures: number;
  }>;
};

type RiskControllerLike = {
  isPaused(): boolean;
};

type LifecycleEngineLike = {
  getStats(): { running: boolean; lastCycleAt: number };
};

type OrderTrackerLike = {
  getSubmitted(): Array<{ id: string }>;
};

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  status: HealthStatus;
  uptime: number;
  lastCycleAt: number;
  exchanges: Array<{
    id: string;
    connected: boolean;
    consecutiveFailures: number;
  }>;
  riskState: { paused: boolean };
  inflightOrders: number;
  checks: Array<{ name: string; status: HealthStatus; detail?: string }>;
}

export class HealthProbe {
  private startedAt = Date.now();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private deps: {
      healthStore: ExchangeHealthStoreLike;
      riskController: RiskControllerLike;
      lifecycleEngineResolver: () => LifecycleEngineLike | undefined;
      orderTracker?: OrderTrackerLike;
    },
  ) {}

  /** Run a full health check. */
  check(): HealthCheckResult {
    const checks: HealthCheckResult["checks"] = [];
    let overallStatus: HealthStatus = "healthy";

    // 1. Lifecycle engine recency
    const lifecycle = this.deps.lifecycleEngineResolver();
    const lastCycleAt = lifecycle?.getStats().lastCycleAt ?? 0;
    const cycleAgeMs = lastCycleAt > 0 ? Date.now() - lastCycleAt : Number.POSITIVE_INFINITY;

    if (cycleAgeMs > 15 * 60_000) {
      checks.push({
        name: "lifecycle_cycle",
        status: "unhealthy",
        detail: `Last cycle ${Math.round(cycleAgeMs / 60_000)}min ago (threshold: 15min)`,
      });
      overallStatus = "unhealthy";
    } else if (cycleAgeMs > 10 * 60_000) {
      checks.push({
        name: "lifecycle_cycle",
        status: "degraded",
        detail: `Last cycle ${Math.round(cycleAgeMs / 60_000)}min ago`,
      });
      if (overallStatus === "healthy") overallStatus = "degraded";
    } else {
      checks.push({ name: "lifecycle_cycle", status: "healthy" });
    }

    // 2. Exchange connectivity
    const exchanges = this.deps.healthStore.listAll();
    const disconnected = exchanges.filter((e) => !e.connected);
    if (disconnected.length > 0) {
      checks.push({
        name: "exchanges",
        status: "degraded",
        detail: `${disconnected.length} disconnected: ${disconnected.map((e) => e.id).join(", ")}`,
      });
      if (overallStatus === "healthy") overallStatus = "degraded";
    } else {
      checks.push({ name: "exchanges", status: "healthy" });
    }

    // 3. Risk controller paused
    const paused = this.deps.riskController.isPaused();
    if (paused) {
      checks.push({
        name: "risk_controller",
        status: "degraded",
        detail: "Trading is paused (emergency stop active)",
      });
      if (overallStatus === "healthy") overallStatus = "degraded";
    } else {
      checks.push({ name: "risk_controller", status: "healthy" });
    }

    // 4. In-flight orders
    const inflightOrders = this.deps.orderTracker?.getSubmitted().length ?? 0;
    if (inflightOrders > 5) {
      checks.push({
        name: "inflight_orders",
        status: "degraded",
        detail: `${inflightOrders} orders in SUBMITTED state`,
      });
      if (overallStatus === "healthy") overallStatus = "degraded";
    } else {
      checks.push({ name: "inflight_orders", status: "healthy" });
    }

    return {
      status: overallStatus,
      uptime: Date.now() - this.startedAt,
      lastCycleAt,
      exchanges: exchanges.map((e) => ({
        id: e.exchangeId,
        connected: e.connected,
        consecutiveFailures: e.consecutiveFailures,
      })),
      riskState: { paused },
      inflightOrders,
      checks,
    };
  }

  /** Start writing a heartbeat timestamp file every 5s for external watchdog. */
  startHeartbeatWriter(filePath: string): void {
    if (this.heartbeatTimer) return;
    mkdirSync(dirname(filePath), { recursive: true });
    const write = () => {
      try {
        writeFileSync(filePath, JSON.stringify({ ts: Date.now(), pid: process.pid }));
      } catch {
        // Best-effort — external watchdog will detect stale file
      }
    };
    write();
    this.heartbeatTimer = setInterval(write, 5000);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
