/**
 * Health Monitoring Agent
 *
 * Monitors BCL agents status, database connectivity, and system resources
 * Alerts on critical errors and provides health reports
 */

import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { getDatabase, type Database } from "../db/database.js";
import {
  BCL_CORE_VALUES,
  type BCLAgentType,
  type HealthStatus,
  type AgentHealth,
} from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SystemResources {
  cpu: {
    usagePercent: number;
    cores: number;
    loadAverage: number[];
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
  };
  gpu: {
    available: boolean;
    memory?: {
      total: number;
      used: number;
      free: number;
    };
    usage?: number;
  };
  storage: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
  };
}

export interface HealthReport {
  status: "healthy" | "degraded" | "critical";
  timestamp: Date;
  agents: Record<BCLAgentType, AgentHealth>;
  database: {
    connected: boolean;
    latencyMs?: number;
    error?: string;
  };
  resources: SystemResources;
  alerts: HealthAlert[];
}

export interface HealthAlert {
  id: string;
  level: "warning" | "critical";
  source: "agent" | "database" | "resources";
  message: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ResourceThresholds {
  cpuPercent: number;
  memoryPercent: number;
  storagePercent: number;
}

const DEFAULT_THRESHOLDS: ResourceThresholds = {
  cpuPercent: 90,
  memoryPercent: 85,
  storagePercent: 90,
};

const AGENT_TYPES: BCLAgentType[] = [
  "research",
  "competitor",
  "builder",
  "security",
  "marketer",
  "finance",
  "market_predictor",
  "test_generator",
  "comms",
  "health",
  "rate_limit_manager",
];

export class HealthAgent {
  private api: OpenClawPluginApi;
  private database: Database;
  private thresholds: ResourceThresholds;
  private alerts: Map<string, HealthAlert> = new Map();
  private lastCheckTime: Date | null = null;

  constructor(api: OpenClawPluginApi, thresholds?: Partial<ResourceThresholds>) {
    this.api = api;
    this.database = getDatabase();
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.api.logger.info("HealthAgent: Initialized");
  }

  async checkAgentHealth(): Promise<Record<BCLAgentType, AgentHealth>> {
    const agentHealth: Record<BCLAgentType, AgentHealth> = {} as Record<
      BCLAgentType,
      AgentHealth
    >;

    try {
      const dbHealth = this.database.getHealthStatus();
      const now = new Date();

      for (const agentType of AGENT_TYPES) {
        const existingHealth = dbHealth.agents[agentType];
        if (existingHealth) {
          agentHealth[agentType] = existingHealth;
        } else {
          const timeSinceLastRun = existingHealth?.last_run
            ? now.getTime() - new Date(existingHealth.last_run).getTime()
            : null;
          const isStale = timeSinceLastRun && timeSinceLastRun > 3600000;

          agentHealth[agentType] = {
            status: isStale ? "degraded" : "healthy",
            last_run: existingHealth?.last_run,
            error_count: existingHealth?.error_count || 0,
            last_error: existingHealth?.last_error,
          };
        }

        if (agentHealth[agentType].error_count > 5) {
          agentHealth[agentType].status = "degraded";
          if (agentHealth[agentType].error_count > 10) {
            agentHealth[agentType].status = "down";
            await this.alertCritical(
              `Agent ${agentType} is down with ${agentHealth[agentType].error_count} errors`,
              "agent",
              { agentType, errorCount: agentHealth[agentType].error_count },
            );
          }
        }
      }

      this.api.logger.debug("HealthAgent: Agent health check completed", {
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.api.logger.error("HealthAgent: Failed to check agent health", error);
      for (const agentType of AGENT_TYPES) {
        agentHealth[agentType] = {
          status: "down",
          error_count: 1,
          last_error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return agentHealth;
  }

  async checkDatabase(): Promise<{ connected: boolean; latencyMs?: number; error?: string }> {
    const result = { connected: false, latencyMs: undefined as number | undefined };

    try {
      const startTime = Date.now();
      this.database.getDb().prepare("SELECT 1").get();
      result.latencyMs = Date.now() - startTime;

      if (result.latencyMs > 1000) {
        result.connected = true;
        await this.alertCritical(
          `Database latency high: ${result.latencyMs}ms`,
          "database",
          { latencyMs: result.latencyMs },
        );
      } else {
        result.connected = true;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.error = errorMessage;
      await this.alertCritical(
        `Database connection failed: ${errorMessage}`,
        "database",
        { error: errorMessage },
      );
      this.api.logger.error("HealthAgent: Database check failed", error);
    }

    return result;
  }

  async checkResources(): Promise<SystemResources> {
    const resources: SystemResources = {
      cpu: {
        usagePercent: 0,
        cores: os.cpus().length,
        loadAverage: os.loadavg(),
      },
      memory: {
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        usagePercent: 0,
      },
      gpu: {
        available: false,
      },
      storage: {
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        usagePercent: 0,
      },
    };

    try {
      const cpus = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;

      for (const cpu of cpus) {
        for (const type in cpu.times) {
          totalTick += cpu.times[type as keyof typeof cpu.times];
        }
        totalIdle += cpu.times.idle;
      }

      resources.cpu.usagePercent =
        totalTick > 0 ? Math.round(((totalTick - totalIdle) / totalTick) * 100) : 0;

      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      resources.memory.totalBytes = totalMem;
      resources.memory.freeBytes = freeMem;
      resources.memory.usedBytes = totalMem - freeMem;
      resources.memory.usagePercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

      const homedir = os.homedir();
      try {
        const stats = fs.statfsSync(homedir);
        resources.storage.totalBytes = stats.bsize * stats.blocks;
        resources.storage.freeBytes = stats.bsize * stats.bfree;
        resources.storage.usedBytes = resources.storage.totalBytes - resources.storage.freeBytes;
        resources.storage.usagePercent = Math.round(
          ((resources.storage.totalBytes - resources.storage.freeBytes) / resources.storage.totalBytes) *
            100,
        );
      } catch {
        const driveLetter = process.platform === "win32" ? "C:" : "";
        const statsPath = path.join(driveLetter, "/");
        try {
          const stats = fs.statfsSync(statsPath);
          resources.storage.totalBytes = stats.bsize * stats.blocks;
          resources.storage.freeBytes = stats.bsize * stats.bfree;
          resources.storage.usedBytes =
            resources.storage.totalBytes - resources.storage.freeBytes;
          resources.storage.usagePercent = Math.round(
            ((resources.storage.totalBytes - resources.storage.freeBytes) /
              resources.storage.totalBytes) *
              100,
          );
        } catch {
          resources.storage = {
            totalBytes: 0,
            usedBytes: 0,
            freeBytes: 0,
            usagePercent: 0,
          };
        }
      }

      if (resources.cpu.usagePercent > this.thresholds.cpuPercent) {
        await this.alertCritical(
          `High CPU usage: ${resources.cpu.usagePercent}%`,
          "resources",
          { cpuPercent: resources.cpu.usagePercent },
        );
      }

      if (resources.memory.usagePercent > this.thresholds.memoryPercent) {
        await this.alertCritical(
          `High memory usage: ${resources.memory.usagePercent}%`,
          "resources",
          { memoryPercent: resources.memory.usagePercent },
        );
      }

      if (resources.storage.usagePercent > this.thresholds.storagePercent) {
        await this.alertCritical(
          `High storage usage: ${resources.storage.usagePercent}%`,
          "resources",
          { storagePercent: resources.storage.usagePercent },
        );
      }

      try {
        const gpuInfo = await this.checkGpuResources();
        resources.gpu = gpuInfo;
      } catch {
        resources.gpu = { available: false };
      }
    } catch (error) {
      this.api.logger.error("HealthAgent: Failed to check resources", error);
    }

    return resources;
  }

  private async checkGpuResources(): Promise<SystemResources["gpu"]> {
    const result: SystemResources["gpu"] = { available: false };

    try {
      if (process.platform === "win32") {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);

        try {
          const { stdout } = await execAsync(
            "nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits",
            { timeout: 5000 },
          );
          const lines = stdout.trim().split("\n");
          if (lines.length > 0) {
            const values = lines[0].split(",").map((v) => parseInt(v.trim(), 10));
            result.available = true;
            result.memory = {
              used: values[0] * 1024 * 1024,
              total: values[1] * 1024 * 1024,
              free: (values[1] - values[0]) * 1024 * 1024,
            };
            result.usage = values[2];
          }
        } catch {
          try {
            const { stdout: amdOut } = await execAsync(
              "rocm-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits",
              { timeout: 5000 },
            );
            const lines = amdOut.trim().split("\n");
            if (lines.length > 0) {
              const values = lines[0].split(",").map((v) => parseInt(v.trim(), 10));
              result.available = true;
              result.memory = {
                used: values[0] * 1024 * 1024,
                total: values[1] * 1024 * 1024,
                free: (values[1] - values[0]) * 1024 * 1024,
              };
              result.usage = values[2];
            }
          } catch {
            result.available = false;
          }
        }
      } else {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);

        try {
          const { stdout } = await execAsync(
            "nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits",
            { timeout: 5000 },
          );
          const lines = stdout.trim().split("\n");
          if (lines.length > 0) {
            const values = lines[0].split(",").map((v) => parseInt(v.trim(), 10));
            result.available = true;
            result.memory = {
              used: values[0] * 1024 * 1024,
              total: values[1] * 1024 * 1024,
              free: (values[1] - values[0]) * 1024 * 1024,
            };
            result.usage = values[2];
          }
        } catch {
          result.available = false;
        }
      }
    } catch {
      result.available = false;
    }

    return result;
  }

  async getHealthReport(): Promise<HealthReport> {
    const agents = await this.checkAgentHealth();
    const database = await this.checkDatabase();
    const resources = await this.checkResources();

    let overallStatus: "healthy" | "degraded" | "critical" = "healthy";
    const downAgents = Object.values(agents).filter((a) => a.status === "down").length;
    const degradedAgents = Object.values(agents).filter((a) => a.status === "degraded").length;

    if (!database.connected || downAgents > 0) {
      overallStatus = "critical";
    } else if (degradedAgents > 0 || database.latencyMs && database.latencyMs > 1000) {
      overallStatus = "degraded";
    } else if (
      resources.cpu.usagePercent > 80 ||
      resources.memory.usagePercent > 80 ||
      resources.storage.usagePercent > 80
    ) {
      overallStatus = "degraded";
    }

    const report: HealthReport = {
      status: overallStatus,
      timestamp: new Date(),
      agents,
      database,
      resources,
      alerts: Array.from(this.alerts.values()),
    };

    this.lastCheckTime = new Date();
    this.api.logger.debug("HealthAgent: Health report generated", {
      status: overallStatus,
      downAgents,
      degradedAgents,
      dbConnected: database.connected,
    });

    return report;
  }

  async alertCritical(
    message: string,
    source: "agent" | "database" | "resources",
    metadata?: Record<string, unknown>,
  ): Promise<HealthAlert> {
    const alert: HealthAlert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      level: "critical",
      source,
      message,
      timestamp: new Date(),
      metadata,
    };

    this.alerts.set(alert.id, alert);

    this.api.logger.error(`HealthAgent [CRITICAL]: ${message}`, {
      alertId: alert.id,
      source,
      metadata,
    });

    return alert;
  }

  async alertWarning(
    message: string,
    source: "agent" | "database" | "resources",
    metadata?: Record<string, unknown>,
  ): Promise<HealthAlert> {
    const alert: HealthAlert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      level: "warning",
      source,
      message,
      timestamp: new Date(),
      metadata,
    };

    this.alerts.set(alert.id, alert);

    this.api.logger.warn(`HealthAgent [WARNING]: ${message}`, {
      alertId: alert.id,
      source,
      metadata,
    });

    return alert;
  }

  getAlerts(): HealthAlert[] {
    return Array.from(this.alerts.values());
  }

  clearAlerts(): void {
    this.alerts.clear();
  }

  getLastCheckTime(): Date | null {
    return this.lastCheckTime;
  }

  async updateAgentStatus(
    agentType: BCLAgentType,
    status: "healthy" | "degraded" | "down",
    error?: string,
  ): Promise<void> {
    try {
      this.database.updateAgentHealth(agentType, status, error);
      this.api.logger.debug(`HealthAgent: Updated agent ${agentType} status to ${status}`, {
        agentType,
        status,
        error,
      });
    } catch (err) {
      this.api.logger.error(`HealthAgent: Failed to update agent status`, err);
    }
  }

  setThresholds(thresholds: Partial<ResourceThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
    this.api.logger.info("HealthAgent: Thresholds updated", this.thresholds);
  }

  getThresholds(): ResourceThresholds {
    return { ...this.thresholds };
  }
}

export function createHealthAgent(
  api: OpenClawPluginApi,
  thresholds?: Partial<ResourceThresholds>,
): HealthAgent {
  return new HealthAgent(api, thresholds);
}
